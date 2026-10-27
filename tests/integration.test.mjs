// LLM-free integration tests against a REAL Vmotion CLI and a real tiny
// project (the starter shipped inside the skill). Skipped unless VMOTION_CLI
// is set, e.g.
//   VMOTION_CLI='["node","/path/to/vmotion/dist/cli/index.mjs"]' \
//   VMOTION_NATIVE=/path/vmotion-core VMOTION_RUNTIME=/path/runtime npm test
// VMOTION_CLI may also be a plain executable path ("vmotion").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup, callTool, textOf } from './support/harness.mjs'
import { DSH_INSTALL_DIR } from './support/dsh-hooks.mjs'
import { buildChildEnv, runCli } from '../lib/run-cli.js'

const RAW = process.env.VMOTION_CLI
const command = RAW === undefined ? undefined : RAW.trim().startsWith('[') ? JSON.parse(RAW) : [RAW]
const skip = command === undefined ? 'set VMOTION_CLI to run real-CLI integration tests' : false
const STARTER = fileURLToPath(new URL('../assets/skills/vmotion/examples/starter', import.meta.url))

function pngSize(file) {
  const buf = readFileSync(file)
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is a PNG`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length }
}

function freshStarter() {
  const dir = join(mkdtempSync(join(tmpdir(), 'vmdsh-it-')), 'starter')
  cpSync(STARTER, dir, { recursive: true })
  return dir
}

test('real CLI: doctor, context, validate, frame, sample on the starter project', { skip, timeout: 600_000 }, async () => {
  const project = freshStarter()
  const ctx = await setup({ command })
  try {
    const doctor = await callTool(ctx, 'vmotion_doctor', {})
    assert.equal(doctor.isError, false, textOf(doctor))
    assert.equal(doctor.value.ok, true, textOf(doctor))
    assert.match(doctor.value.version, /^\d+\.\d+\.\d+/)

    const context = await callTool(ctx, 'vmotion_context', { project })
    assert.equal(context.isError, false, textOf(context))
    assert.match(JSON.stringify(context.value.result), /"intro"/)

    const valid = await callTool(ctx, 'vmotion_validate', { project })
    assert.equal(valid.isError, false, textOf(valid))
    assert.equal(valid.value.ok, true, textOf(valid))
    assert.equal(valid.value.result.valid, true)

    const frame = await callTool(ctx, 'vmotion_frame', { project, frame: 30 })
    assert.equal(frame.isError, false, textOf(frame))
    const framePath = frame.value.result.output
    assert.equal(framePath, join(project, 'exports', 'dsh', 'frame-30.png'))
    const size = pngSize(framePath)
    assert.deepEqual([size.width, size.height], [1280, 720])
    assert.ok(size.bytes > 5000, 'frame has real content')

    const small = await callTool(ctx, 'vmotion_frame', { project, frame: 0, width: 320, height: 180, output: join(project, 'exports', 'dsh', 'small.png') })
    assert.equal(small.isError, false, textOf(small))
    const s = pngSize(small.value.result.output)
    assert.deepEqual([s.width, s.height], [320, 180])

    const sheet = await callTool(ctx, 'vmotion_sample', { project, frames: [0, 45, 89], width: 320 })
    assert.equal(sheet.isError, false, textOf(sheet))
    assert.ok(pngSize(join(project, 'exports', 'dsh', 'sample-0_45_89.png')).bytes > 5000)
  } finally { await ctx.fiber.dispose() }
})

test('real CLI: an invalid edit is a domain result (exit 2) with JSX diagnostics', { skip, timeout: 300_000 }, async () => {
  const project = freshStarter()
  const file = join(project, 'components', 'title-card.tsx')
  writeFileSync(file, readFileSync(file, 'utf8').replace('<rect', '<div'))
  const ctx = await setup({ command })
  try {
    const r = await callTool(ctx, 'vmotion_validate', { project })
    assert.equal(r.isError, false, textOf(r))
    assert.equal(r.value.ok, false)
    assert.equal(r.value.exitCode, 2)
    assert.equal(r.value.result.valid, false)
    assert.match(JSON.stringify(r.value.result.diagnostics), /JSX_/)
  } finally { await ctx.fiber.dispose() }
})

test('real CLI: render a short MP4 range, probe encoders', { skip, timeout: 900_000 }, async () => {
  const project = freshStarter()
  const ctx = await setup({ command })
  try {
    const r = await callTool(ctx, 'vmotion_render', { project, start: 0, end: 15, width: 320, height: 180 })
    assert.equal(r.isError, false, textOf(r))
    assert.equal(r.value.ok, true, textOf(r))
    const out = join(project, 'exports', 'render.mp4')
    assert.ok(existsSync(out), 'mp4 written')
    assert.equal(readFileSync(out).subarray(4, 8).toString('latin1'), 'ftyp', 'MP4 container')
    assert.ok(statSync(out).size > 1000)

    const enc = await callTool(ctx, 'vmotion_encoders', { project, codecs: ['h264'] })
    assert.equal(enc.isError, false, textOf(enc))
    assert.ok(enc.value.result !== null)
  } finally { await ctx.fiber.dispose() }
})

test('real CLI: still project image export', { skip, timeout: 600_000 }, async () => {
  const project = join(mkdtempSync(join(tmpdir(), 'vmdsh-still-')), 'poster')
  const init = await runCli({
    command, args: ['init', '--project', project, '--kind', 'still', '--preset', 'square', '--still-template', 'card', '--json'],
    cwd: tmpdir(), env: buildChildEnv(process.env, {}), timeoutMs: 300_000,
    signal: new AbortController().signal, maxOutputBytes: 1 << 22, killGraceMs: 1000,
  })
  assert.equal(init.exitCode, 0, init.stderr)
  const ctx = await setup({ command })
  try {
    const r = await callTool(ctx, 'vmotion_image_export', { project, format: 'png', output: join(project, 'exports', 'dsh', 'poster.png') })
    assert.equal(r.isError, false, textOf(r))
    const pngs = readdirSync(join(project, 'exports', 'dsh')).filter(n => n.endsWith('.png'))
    assert.ok(pngs.length >= 1, 'still exported')
    assert.ok(pngSize(join(project, 'exports', 'dsh', pngs[0])).bytes > 1000)
  } finally { await ctx.fiber.dispose() }
})

test('real CLI: cancelling a render stops it', { skip, timeout: 300_000 }, async () => {
  const project = freshStarter()
  const ctx = await setup({ command, killGraceMs: 1000 })
  try {
    const ac = new AbortController()
    const pending = callTool(ctx, 'vmotion_render', { project, output: join(project, 'exports', 'cancel.mp4'), resume: false }, ac.signal)
    setTimeout(() => ac.abort(), 1500)
    const r = await pending
    assert.equal(r.isError, true, 'cancelled call is an error result')
    assert.match(JSON.stringify(r.error) + textOf(r), /ABORT|cancel/i)
  } finally { await ctx.fiber.dispose() }
})

test('optional MCP path: the example patch row is valid dsh-mcp-client config and attaches Vmotion MCP', { skip, timeout: 300_000 }, async () => {
  const yaml = createRequire(join(DSH_INSTALL_DIR, 'package.json'))('js-yaml')
  const patch = yaml.load(readFileSync(fileURLToPath(new URL('../examples/mcp.patch.example.yml', import.meta.url)), 'utf8'))
  const row = patch[0].insert[0]
  assert.equal(row.name, '@deepseek-ai/dsh-mcp-client')
  const McpClient = await import('@deepseek-ai/dsh-mcp-client')
  assert.equal(McpClient.Config(row.config).transport, 'stdio', 'example config validates as-is')
  const project = freshStarter()
  const [cmd, ...prefix] = command
  const config = McpClient.Config({ ...row.config, command: cmd, args: [...prefix, 'mcp', '--project', project, '--tools', 'compact'], env: buildChildEnv(process.env, {}), cwd: project })
  const ctx = await setup({ command })
  try {
    const fiber = ctx.plugin(McpClient, config)
    await fiber
    let names = []
    for (let i = 0; i < 600 && !names.includes('mcp__vmotion__project_context'); i++) {
      await new Promise(r => setTimeout(r, 200))
      names = ctx.tools.schemas().map(s => s.name)
    }
    assert.ok(names.includes('mcp__vmotion__project_context'), `MCP tools registered: ${names.filter(n => n.startsWith('mcp__')).join(', ')}`)
    const r = await callTool(ctx, 'mcp__vmotion__project_context', {})
    assert.equal(r.isError, false, textOf(r))
    assert.match(textOf(r), /intro/)
    await fiber.dispose()
  } finally { await ctx.fiber.dispose() }
})
