// @ts-check
/**
 * Model-facing tools that wrap the local `vmotion` CLI.
 *
 * Every tool builds a fixed argv from validated arguments (no shell on POSIX),
 * resolves `project` / `output` against the session working directory, runs
 * with a configurable deadline, stops the whole process group when the call is
 * cancelled, and returns one canonical JSON value. Editing project files is
 * deliberately NOT a tool: the agent edits files with its normal file tools.
 * @module vmotion-dsh/tools
 */

import { mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildChildEnv, parseJsonOutput, runCli, which } from './run-cli.js'

/** Names of every tool this plugin can register. */
export const TOOL_NAMES = /** @type {const} */ ([
  'vmotion_doctor',
  'vmotion_context',
  'vmotion_validate',
  'vmotion_frame',
  'vmotion_sample',
  'vmotion_image_export',
  'vmotion_render',
  'vmotion_encoders',
])

/**
 * @typedef {object} VmotionToolsConfig
 * @property {string[]} command - argv prefix that starts the CLI.
 * @property {Record<string, string>} env - extra environment for the CLI.
 * @property {number} timeoutMs - deadline for ordinary commands.
 * @property {number} renderTimeoutMs - deadline for `vmotion render` / `image export` / `encoders`.
 * @property {number} maxOutputBytes - stdout/stderr capture cap per stream.
 * @property {number} maxResultChars - model-facing text cap.
 * @property {number} killGraceMs - SIGTERM → SIGKILL grace.
 * @property {string[]} disabledTools - tool names not to register.
 */

/** @type {import('@deepseek-ai/schemastery').default<Partial<VmotionToolsConfig>, VmotionToolsConfig>} */
export const Config = Schema.object({
  command: Schema.array(Schema.string()).min(1).default(['vmotion'])
    .description('argv prefix that starts the Vmotion CLI, e.g. ["vmotion"], ["node", "/opt/vmotion/dist/cli/index.mjs"] or ["C:\\\\Vmotion\\\\vmotion.cmd"]'),
  env: Schema.dict(Schema.string()).default({})
    .description('Extra environment merged over the scrubbed ambient environment (VMOTION_NATIVE, VMOTION_RUNTIME, VMOTION_FFMPEG, VMOTION_FFPROBE, VMOTION_ENCODER …)'),
  timeoutMs: Schema.natural().min(1000).default(180_000)
    .description('Deadline for context/validate/frame/sample/doctor calls, in ms'),
  renderTimeoutMs: Schema.natural().min(1000).default(3_600_000)
    .description('Deadline for render, image export and encoder probing, in ms'),
  maxOutputBytes: Schema.natural().min(1024).default(8 * 1024 * 1024)
    .description('Capture cap per output stream, in bytes'),
  maxResultChars: Schema.natural().min(200).default(20_000)
    .description('Maximum characters of CLI JSON shown to the model per call'),
  killGraceMs: Schema.natural().default(3000)
    .description('Grace period between SIGTERM and SIGKILL when a call is cancelled or times out'),
  disabledTools: Schema.array(Schema.union([...TOOL_NAMES])).default([])
    .description('Tool names this deployment does not register'),
})

/** Canonical result of a CLI-backed tool. */
const RESULT_SCHEMA = /** @type {const} */ ({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'true when the CLI exited 0' },
    exitCode: { type: 'integer', required: true, description: '0 ok; 2 invalid project (validate); 3 render job did not complete' },
    argv: { type: 'array', items: { type: 'string' }, required: true, description: 'CLI arguments after the configured command' },
    cwd: { type: 'string', required: true },
    durationMs: { type: 'integer', required: true },
    result: { type: 'json', required: true, description: 'Parsed CLI JSON output (null when none)' },
    stderr: { type: 'string', description: 'Tail of stderr when the command did not succeed' },
    outputTruncated: { type: 'boolean' },
  },
})

const DOCTOR_SCHEMA = /** @type {const} */ ({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'true when the CLI started and reported a version' },
    command: { type: 'array', items: { type: 'string' }, required: true, description: 'Configured CLI argv prefix' },
    version: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    checks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
    },
  },
})

const ID_PATTERN = /^[^-\s][^\s]*$/
const ENCODER_PATTERN = /^[A-Za-z0-9_]+$/

/**
 * @param {string} field - argument name for the error message.
 * @param {string | undefined} value - candidate id.
 */
function checkId(field, value) {
  if (value !== undefined && !ID_PATTERN.test(value)) throw new Error(`${field} must be a non-empty id without spaces that does not start with "-"`)
}

/** @param {string} field @param {number | undefined} value */
function checkPositive(field, value) {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error(`${field} must be a positive integer`)
}

/** @param {string} field @param {number | undefined} value */
function checkFrame(field, value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(`${field} must be a non-negative integer frame number`)
}

/**
 * Pure model-facing rendering shared by the CLI tools.
 * @param {number} maxChars - text cap.
 * @param {string} label - e.g. `vmotion validate`.
 * @param {{ ok: boolean, exitCode: number, durationMs: number, result: unknown, stderr?: string, outputTruncated?: boolean }} value - canonical value.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function renderResult(maxChars, label, value) {
  let body = JSON.stringify(value.result, null, 2) ?? 'null'
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n… [truncated ${body.length - maxChars} chars; narrow the request, e.g. --scene/--limit]`
  const head = `${label}: exit ${value.exitCode} (${value.ok ? 'ok' : 'not ok'}) in ${value.durationMs} ms${value.outputTruncated === true ? ', output truncated' : ''}`
  const tail = value.stderr ? `\nstderr:\n${value.stderr}` : ''
  return [{ type: 'text', text: `${head}\n${body}${tail}` }]
}

/**
 * Register the Vmotion CLI tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {VmotionToolsConfig} config - validated configuration.
 */
export function apply(ctx, config) {
  /** @type {{ ensure(agent: unknown, signal?: AbortSignal): Promise<string | undefined> } | undefined} */
  let workingDirectory
  // Optional dependency: Cordis 4 `inject` lists are all required, so the
  // session working directory is picked up through a nested inject fiber that
  // only runs while the service exists (absent in minimal compositions/tests).
  ctx.inject(['workingDirectory'], (sub) => {
    workingDirectory = /** @type {any} */ (sub).workingDirectory
    sub.effect(() => () => { workingDirectory = undefined })
  })

  /**
   * Base directory for relative paths: the agent's session cwd when available.
   * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
   * @returns {Promise<string>} absolute directory.
   */
  async function baseDir(exec) {
    if (exec.agent !== undefined && workingDirectory !== undefined) {
      const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
      if (cwd !== undefined) return cwd
    }
    return process.cwd()
  }

  /**
   * Resolve and check a project directory.
   * @param {string} base - base directory.
   * @param {string | undefined} project - user path.
   * @returns {Promise<string>} absolute project dir containing project.vmotion.json.
   */
  async function projectDir(base, project) {
    const dir = resolve(base, project ?? '.')
    let info
    try { info = await stat(dir) } catch { throw new Error(`project directory not found: ${dir}`) }
    if (!info.isDirectory()) throw new Error(`project is not a directory: ${dir}`)
    if (!existsSync(join(dir, 'project.vmotion.json'))) throw new Error(`not a Vmotion project (no project.vmotion.json): ${dir}. Create one by writing the files (see the vmotion skill) or run \`vmotion init\`.`)
    return dir
  }

  const env = () => buildChildEnv(process.env, config.env)

  /**
   * Run one CLI command and normalize the outcome.
   * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
   * @param {string} cwd - child cwd.
   * @param {string[]} argv - arguments after the command prefix.
   * @param {{ long?: boolean, okExitCodes?: number[] }} [opts] - deadline class and non-error exit codes.
   */
  async function run(exec, cwd, argv, opts = {}) {
    const res = await runCli({
      command: config.command,
      args: argv,
      cwd,
      env: env(),
      timeoutMs: opts.long === true ? config.renderTimeoutMs : config.timeoutMs,
      signal: exec.signal,
      maxOutputBytes: config.maxOutputBytes,
      killGraceMs: config.killGraceMs,
    })
    const parsed = parseJsonOutput(res.stdout)
    const accepted = [0, ...(opts.okExitCodes ?? [])]
    if (!accepted.includes(res.exitCode)) {
      const errJson = /** @type {any} */ (parseJsonOutput(res.stderr))
      const detail = errJson?.error ? `${errJson.error.code ?? 'ERROR'}: ${errJson.error.message ?? ''}` : (res.stderr.trim().slice(-2000) || res.stdout.trim().slice(-2000))
      throw new Error(`vmotion ${argv[0]} failed (exit ${res.exitCode}): ${detail}`)
    }
    return {
      ok: res.exitCode === 0,
      exitCode: res.exitCode,
      argv,
      cwd,
      durationMs: res.durationMs,
      result: /** @type {import('@deepseek-ai/dsh-util-values').JsonValue} */ (parsed ?? (res.stdout.trim() === '' ? null : res.stdout.trim().slice(-4000))),
      ...res.exitCode !== 0 && res.stderr.trim() !== '' ? { stderr: res.stderr.trim().slice(-2000) } : {},
      ...res.truncated ? { outputTruncated: true } : {},
    }
  }

  /**
   * @param {string} base - base dir.
   * @param {string | undefined} output - user output path.
   * @param {string} fallback - absolute default.
   * @param {boolean} [isDir] - output is a directory (png sequence).
   */
  async function outputPath(base, output, fallback, isDir = false) {
    const path = output === undefined ? fallback : resolve(base, output)
    await mkdir(isDir ? path : dirname(path), { recursive: true })
    return path
  }

  const text = (/** @type {string} */ label) => (/** @type {any} */ _args, /** @type {any} */ value) => renderResult(config.maxResultChars, label, value)
  const enabled = (/** @type {string} */ toolName) => !config.disabledTools.includes(/** @type {any} */ (toolName))
  const projectParam = /** @type {const} */ ({ type: 'string', description: 'Vmotion project directory (contains project.vmotion.json); relative to the session working directory. Default "."' })

  /** @type {import('@deepseek-ai/dsh-tools').ToolDefinition[]} */
  const tools = []

  tools.push(defineTool({
    name: 'vmotion_doctor',
    description: 'Check that the Vmotion CLI is reachable and report its version, plus whether the native renderer, CJK fonts and FFmpeg are configured. Run it first in a new environment or when another vmotion_* tool fails to start.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: DOCTOR_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `${value.ok ? 'Vmotion CLI ok' : 'Vmotion CLI NOT usable'} (command ${JSON.stringify(value.command)}, version ${value.version ?? 'unknown'})\n${value.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')}` }],
    },
    async execute(_args, exec) {
      const childEnv = env()
      /** @type {{ name: string, ok: boolean, detail: string }[]} */
      const checks = []
      let version = /** @type {string | null} */ (null)
      try {
        const res = await runCli({ command: config.command, args: ['--version'], cwd: await baseDir(exec), env: childEnv, timeoutMs: config.timeoutMs, signal: exec.signal, maxOutputBytes: 65536, killGraceMs: config.killGraceMs })
        if (res.exitCode === 0 && res.stdout.trim() !== '') version = res.stdout.trim().split(/\r?\n/).pop() ?? null
        checks.push({ name: 'cli', ok: version !== null, detail: version !== null ? `vmotion ${version}` : `exit ${res.exitCode}: ${res.stderr.trim().slice(-500)}` })
      } catch (error) {
        if (exec.signal.aborted) throw error
        checks.push({ name: 'cli', ok: false, detail: /** @type {Error} */ (error).message })
      }
      const fileCheck = (/** @type {string} */ name, /** @type {string | undefined} */ path, /** @type {string} */ unset) => {
        if (path === undefined || path === '') checks.push({ name, ok: true, detail: unset })
        else checks.push({ name, ok: existsSync(path), detail: existsSync(path) ? path : `missing: ${path}` })
      }
      fileCheck('VMOTION_NATIVE', childEnv.VMOTION_NATIVE, 'not set (the CLI uses its bundled/built native core)')
      const runtime = childEnv.VMOTION_RUNTIME
      if (runtime === undefined || runtime === '') checks.push({ name: 'VMOTION_RUNTIME', ok: true, detail: 'not set (portable package bundles fonts; from source, Chinese text needs fonts/NotoSansSC-*.otf)' })
      else {
        const font = join(runtime, 'fonts', 'NotoSansSC-Regular.otf')
        checks.push({ name: 'VMOTION_RUNTIME', ok: existsSync(font), detail: existsSync(font) ? `${runtime} (CJK fonts found)` : `${runtime} has no fonts/NotoSansSC-Regular.otf` })
      }
      for (const [name, bin] of /** @type {const} */ ([['VMOTION_FFMPEG', 'ffmpeg'], ['VMOTION_FFPROBE', 'ffprobe']])) {
        const configured = childEnv[name]
        if (configured !== undefined && configured !== '') fileCheck(name, configured, '')
        else {
          const found = which(bin, childEnv)
          checks.push({ name, ok: true, detail: found !== undefined ? `not set; ${bin} on PATH: ${found}` : `not set and no ${bin} on PATH (portable package bundles it; needed for MP4/WAV render)` })
        }
      }
      return { ok: version !== null, command: [...config.command], version, checks }
    },
  }))

  tools.push(defineTool({
    name: 'vmotion_context',
    description: 'Read a compact overview of a Vmotion project: scene/sequence ids, durations, components, source file sha256 hashes, diagnostics and pending files (`vmotion context`). Use it before editing project files.',
    parameters: {
      project: projectParam,
      scene: { type: 'string', description: 'Limit to one scene id' },
      sequence: { type: 'string', description: 'Limit to one sequence id' },
      offset: { type: 'integer', description: 'Page offset (default 0)' },
      limit: { type: 'integer', description: 'Page length (default 100)' },
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    output: { schema: RESULT_SCHEMA, render: text('vmotion context') },
    async execute(args, exec) {
      checkId('scene', args.scene); checkId('sequence', args.sequence)
      checkFrame('offset', args.offset); checkPositive('limit', args.limit)
      const base = await baseDir(exec)
      const dir = await projectDir(base, args.project)
      const argv = ['context', '--project', dir, '--json']
      if (args.scene !== undefined) argv.push('--scene', args.scene)
      if (args.sequence !== undefined) argv.push('--sequence', args.sequence)
      if (args.offset !== undefined) argv.push('--offset', String(args.offset))
      if (args.limit !== undefined) argv.push('--limit', String(args.limit))
      return run(exec, base, argv)
    },
  }))

  tools.push(defineTool({
    name: 'vmotion_validate',
    description: 'Validate a Vmotion project after editing files: schema, references, TypeScript compile and static JSX lint (`vmotion validate --json`). Returns ok:false with result.valid:false and result.diagnostics when the project is invalid. Does not render frames, so also render a few frames with vmotion_sample.',
    parameters: { project: projectParam },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    output: { schema: RESULT_SCHEMA, render: text('vmotion validate') },
    async execute(args, exec) {
      const base = await baseDir(exec)
      const dir = await projectDir(base, args.project)
      return run(exec, base, ['validate', '--project', dir, '--json'], { okExitCodes: [2] })
    },
  }))

  tools.push(defineTool({
    name: 'vmotion_frame',
    description: 'Render one full frame of a Vmotion project to a PNG with the native renderer (`vmotion frame`). Returns the absolute PNG path in result.output; open it to check the picture.',
    parameters: {
      project: projectParam,
      frame: { type: 'integer', required: true, description: 'Frame number (0-based)' },
      scene: { type: 'string', description: 'Scene id (default: active sequence)' },
      output: { type: 'string', description: 'PNG path; default <project>/exports/dsh/frame-<n>.png' },
      width: { type: 'integer', description: 'Output width; give width and height together or neither' },
      height: { type: 'integer', description: 'Output height' },
    },
    timeoutMs: config.timeoutMs,
    output: { schema: RESULT_SCHEMA, render: text('vmotion frame') },
    async execute(args, exec) {
      checkFrame('frame', args.frame); checkId('scene', args.scene)
      checkPositive('width', args.width); checkPositive('height', args.height)
      if ((args.width === undefined) !== (args.height === undefined)) throw new Error('give width and height together, or neither (width alone squeezes the aspect ratio)')
      const base = await baseDir(exec)
      const dir = await projectDir(base, args.project)
      const out = await outputPath(base, args.output, join(dir, 'exports', 'dsh', `frame-${args.frame}.png`))
      const argv = ['frame', '--project', dir, '--frame', String(args.frame), '--output', out, '--json']
      if (args.scene !== undefined) argv.push('--scene', args.scene)
      if (args.width !== undefined && args.height !== undefined) argv.push('--width', String(args.width), '--height', String(args.height))
      return run(exec, base, argv)
    },
  }))

  tools.push(defineTool({
    name: 'vmotion_sample',
    description: 'Render 1–12 frames of a Vmotion project into one labelled contact-sheet PNG (`vmotion sample`). Use after every meaningful edit to check entrance, midpoint, transitions and the last frame.',
    parameters: {
      project: projectParam,
      frames: { type: 'array', items: { type: 'integer' }, required: true, description: '1 to 12 frame numbers, e.g. [0, 15, 45, 89]' },
      scene: { type: 'string', description: 'Scene id (default: active sequence)' },
      width: { type: 'integer', description: 'Tile width in pixels (default 640)' },
      output: { type: 'string', description: 'PNG path; default <project>/exports/dsh/sample-<frames>.png' },
    },
    timeoutMs: config.timeoutMs,
    output: { schema: RESULT_SCHEMA, render: text('vmotion sample') },
    async execute(args, exec) {
      if (args.frames.length < 1 || args.frames.length > 12) throw new Error('frames must list 1 to 12 frame numbers')
      for (const f of args.frames) checkFrame('frames[]', f)
      checkId('scene', args.scene); checkPositive('width', args.width)
      const base = await baseDir(exec)
      const dir = await projectDir(base, args.project)
      const out = await outputPath(base, args.output, join(dir, 'exports', 'dsh', `sample-${args.frames.join('_')}.png`))
      const argv = ['sample', '--project', dir, '--frames', args.frames.join(','), '--output', out, '--json']
      if (args.scene !== undefined) argv.push('--scene', args.scene)
      if (args.width !== undefined) argv.push('--width', String(args.width))
      return run(exec, base, argv)
    },
  }))

  tools.push(defineTool({
    name: 'vmotion_image_export',
    description: 'Export a still-image artboard (poster, cover, card) of a Vmotion still project as PNG, JPEG or WebP (`vmotion image export`).',
    parameters: {
      project: projectParam,
      scene: { type: 'string', description: 'Still scene id (default: first still)' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default png)' },
      output: { type: 'string', description: 'File (single image) or directory; default <project>/exports/images' },
      scale: { type: 'number', description: 'Pixel scale, e.g. 1, 2 or 3' },
      quality: { type: 'integer', description: 'JPEG/WebP quality 1-100' },
      transparent: { type: 'boolean', description: 'Omit the background (PNG/WebP)' },
      trim: { type: 'boolean', description: 'Crop off the bleed' },
    },
    timeoutMs: config.renderTimeoutMs,
    output: { schema: RESULT_SCHEMA, render: text('vmotion image export') },
    async execute(args, exec) {
      checkId('scene', args.scene)
      if (args.scale !== undefined && !(args.scale > 0 && args.scale <= 8)) throw new Error('scale must be > 0 and <= 8')
      if (args.quality !== undefined && !(Number.isInteger(args.quality) && args.quality >= 1 && args.quality <= 100)) throw new Error('quality must be an integer 1-100')
      const base = await baseDir(exec)
      const dir = await projectDir(base, args.project)
      const argv = ['image', 'export', '--project', dir]
      if (args.scene !== undefined) argv.push('--scene', args.scene)
      if (args.format !== undefined) argv.push('--format', args.format)
      if (args.output !== undefined) {
        const out = resolve(base, args.output)
        await mkdir(/\.(png|jpe?g|webp)$/i.test(out) ? dirname(out) : out, { recursive: true })
        argv.push('--output', out)
      }
      if (args.scale !== undefined) argv.push('--scale', String(args.scale))
      if (args.quality !== undefined) argv.push('--quality', String(args.quality))
      if (args.transparent === true) argv.push('--transparent')
      if (args.trim === true) argv.push('--trim')
      return run(exec, base, argv, { long: true })
    },
  }))

  tools.push(defineTool({
    name: 'vmotion_render',
    description: 'Export the active sequence of a Vmotion project as MP4 video, a PNG frame sequence or WAV audio (`vmotion render`); waits for the job. Long-running: render a short --start/--end range first when unsure. ok:false with exitCode 3 means the job did not complete.',
    parameters: {
      project: projectParam,
      output: { type: 'string', description: 'Output file (mp4/wav) or directory (png); default <project>/exports/render.<ext> or exports/render-png/' },
      format: { type: 'string', enum: ['mp4', 'png', 'wav'], description: 'Default mp4' },
      start: { type: 'integer', description: 'First frame of the active sequence (inclusive)' },
      end: { type: 'integer', description: 'End frame (exclusive)' },
      width: { type: 'integer', description: 'Output width; give width and height together' },
      height: { type: 'integer', description: 'Output height' },
      encoder: { type: 'string', description: 'MP4 encoder: auto, software, nvenc, qsv, amf, mediafoundation, videotoolbox, vaapi or an FFmpeg encoder name (see vmotion_encoders)' },
      codec: { type: 'string', enum: ['h264', 'hevc', 'av1'], description: 'MP4 video codec' },
      resume: { type: 'boolean', description: 'Reuse completed checkpoints (default true); false passes --no-resume' },
    },
    timeoutMs: config.renderTimeoutMs,
    output: { schema: RESULT_SCHEMA, render: text('vmotion render') },
    async execute(args, exec) {
      checkFrame('start', args.start); checkFrame('end', args.end)
      if (args.start !== undefined && args.end !== undefined && args.end <= args.start) throw new Error('end must be greater than start (end is exclusive)')
      checkPositive('width', args.width); checkPositive('height', args.height)
      if ((args.width === undefined) !== (args.height === undefined)) throw new Error('give width and height together, or neither')
      if (args.encoder !== undefined && !ENCODER_PATTERN.test(args.encoder)) throw new Error('encoder must be a plain encoder name such as auto, software, nvenc or libx264')
      const format = args.format ?? 'mp4'
      const base = await baseDir(exec)
      const dir = await projectDir(base, args.project)
      const fallback = format === 'png' ? join(dir, 'exports', 'render-png') : join(dir, 'exports', `render.${format}`)
      const out = await outputPath(base, args.output, fallback, format === 'png')
      const argv = ['render', '--project', dir, '--output', out, '--format', format, '--json']
      if (args.start !== undefined) argv.push('--start', String(args.start))
      if (args.end !== undefined) argv.push('--end', String(args.end))
      if (args.width !== undefined && args.height !== undefined) argv.push('--width', String(args.width), '--height', String(args.height))
      if (args.encoder !== undefined) argv.push('--encoder', args.encoder)
      if (args.codec !== undefined) argv.push('--codec', args.codec)
      if (args.resume === false) argv.push('--no-resume')
      return run(exec, base, argv, { long: true, okExitCodes: [3] })
    },
  }))

  tools.push(defineTool({
    name: 'vmotion_encoders',
    description: 'Probe which FFmpeg H.264/HEVC/AV1 encoders (hardware and software) actually work on this machine with real test encodes (`vmotion encoders`). The CLI loads a project for its FFmpeg/export settings, so pass one.',
    parameters: {
      project: projectParam,
      codecs: { type: 'array', items: { type: 'string', enum: ['h264', 'hevc', 'av1'] }, description: 'Codecs to probe (default all)' },
      bitDepth: { type: 'integer', enum: [8, 10], description: 'Probe 8 or 10-bit surfaces (default 8)' },
    },
    timeoutMs: config.renderTimeoutMs,
    output: { schema: RESULT_SCHEMA, render: text('vmotion encoders') },
    async execute(args, exec) {
      const base = await baseDir(exec)
      const dir = await projectDir(base, args.project)
      const argv = ['encoders', '--project', dir, '--json']
      if (args.codecs !== undefined && args.codecs.length > 0) argv.push('--codec', ...args.codecs)
      if (args.bitDepth !== undefined) argv.push('--bit-depth', String(args.bitDepth))
      return run(exec, base, argv, { long: true })
    },
  }))

  for (const tool of tools) {
    if (enabled(tool.name)) ctx.tools.register(tool)
  }
}

/** Cordis plugin name. */
export const name = 'vmotion-dsh-tools'
/** The tool registry must exist before tools register. */
export const inject = ['tools']

