// LLM-free tests: bundle manifest, skill provider, tool registration,
// argument validation, argv construction, env scrubbing, timeout and
// cancellation — all against the real DSH tool/skill registries from the
// installed runtime, with a fake vmotion CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup, callTool, textOf, skillPlugin, toolsPlugin } from './support/harness.mjs'
import { buildChildEnv, parseJsonOutput, runCli, spawnPlan } from '../lib/run-cli.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-vmotion.mjs', import.meta.url))
// A marker-only project in a temp dir (the fake CLI never reads it; real projects are in integration.test.mjs).
const TINY = mkdtempSync(join(tmpdir(), 'vmdsh-tiny-'))
writeFileSync(join(TINY, 'project.vmotion.json'), '{}')
const fakeConfig = (extra = {}) => ({ command: [process.execPath, FAKE], ...extra })

test('bundle manifest: dsh.bundle patch rows resolve to exported subpaths', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.engines.dsh, 'engines.dsh range declared')
  const patch = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8')
  const names = [...patch.matchAll(/^\s+name:\s*(\S+)\s*$/gm)].map(m => m[1])
  assert.deepEqual(names, ['vmotion-dsh/skill', 'vmotion-dsh/tools'])
  for (const name of names) {
    const sub = './' + name.slice(pkg.name.length + 1)
    assert.ok(pkg.exports[sub], `exports ${sub}`)
    assert.ok(existsSync(join(ROOT, pkg.exports[sub])))
  }
  for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-skill', '@deepseek-ai/schemastery']) {
    assert.ok(pkg.peerDependencies[peer], `peer ${peer}`)
  }
})

test('plugin modules export the Cordis function-plugin shape', () => {
  assert.equal(skillPlugin.name, 'vmotion-dsh-skill')
  assert.deepEqual(skillPlugin.inject, ['skills'])
  assert.equal(typeof skillPlugin.apply, 'function')
  assert.equal(typeof skillPlugin.Config, 'function')
  assert.equal(toolsPlugin.name, 'vmotion-dsh-tools')
  assert.deepEqual(toolsPlugin.inject, ['tools'])
  assert.equal(typeof toolsPlugin.Config, 'function', 'Config is a Schemastery schema, not a plain object')
  assert.deepEqual(toolsPlugin.Config({}).command, ['vmotion'])
  assert.throws(() => toolsPlugin.Config({ command: [] }))
  assert.throws(() => toolsPlugin.Config({ disabledTools: ['not_a_tool'] }))
})

test('skill provider: catalog entry, body without frontmatter, resources', async () => {
  const ctx = await setup(fakeConfig())
  try {
    const list = await ctx.skills.list()
    const entry = list.find(s => s.name === 'vmotion')
    assert.ok(entry, 'vmotion skill listed')
    assert.equal(entry.source, 'bundled')
    assert.equal(entry.provider, 'vmotion-dsh')
    assert.equal(entry.invocation.modelInvocable, true)
    assert.match(entry.description, /Vmotion/)
    const def = await ctx.skills.get('vmotion')
    assert.ok(def)
    assert.ok(!def.content.startsWith('---'), 'frontmatter stripped')
    assert.match(def.content, /files first, CLI second, MCP last/)
    assert.match(def.content, /In DeepSeek Harness \(vmotion-dsh plugin\)/)
    for (const tool of toolsPlugin.TOOL_NAMES) assert.ok(def.content.includes(tool), `skill mentions ${tool}`)
    assert.equal(def.resourceBase.kind, 'directory')
    for (const ref of ['references/cli.md', 'references/jsx.md', 'references/mcp.md', 'examples/starter/project.vmotion.json']) {
      assert.ok(existsSync(join(def.resourceBase.path, ref)), ref)
    }
  } finally { await ctx.fiber.dispose() }
})

test('tools: all eight register; disabledTools is honoured', async () => {
  const ctx = await setup(fakeConfig())
  try {
    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('vmotion_')).sort()
    assert.deepEqual(names, [...toolsPlugin.TOOL_NAMES].sort())
    for (const schema of ctx.tools.schemas().filter(s => s.name.startsWith('vmotion_'))) {
      assert.ok(schema.description.length > 40, `${schema.name} has a real description`)
      assert.equal(schema.parameters.type, 'object')
    }
  } finally { await ctx.fiber.dispose() }
  const ctx2 = await setup(fakeConfig({ disabledTools: ['vmotion_render', 'vmotion_encoders'] }))
  try {
    const names = ctx2.tools.schemas().map(s => s.name)
    assert.ok(!names.includes('vmotion_render') && !names.includes('vmotion_encoders'))
    const r = await callTool(ctx2, 'vmotion_render', { project: TINY })
    assert.equal(r.isError, true)
    const ok = await callTool(ctx2, 'vmotion_validate', { project: TINY })
    assert.equal(ok.isError, false)
  } finally { await ctx2.fiber.dispose() }
})

test('argv construction and path resolution (fake CLI)', async () => {
  const ctx = await setup(fakeConfig({ env: { VMOTION_EXTRA: 'from-config' } }))
  try {
    const frame = await callTool(ctx, 'vmotion_frame', { project: TINY, frame: 12, scene: 'intro', width: 320, height: 180, output: join(TINY, 'out', 'f.png') })
    assert.equal(frame.isError, false, textOf(frame))
    assert.deepEqual(frame.value.result.argv, ['frame', '--project', TINY, '--frame', '12', '--output', join(TINY, 'out', 'f.png'), '--json', '--scene', 'intro', '--width', '320', '--height', '180'])
    assert.equal(frame.value.result.extra, 'from-config')
    assert.equal(frame.value.ok, true)

    const sample = await callTool(ctx, 'vmotion_sample', { project: TINY, frames: [0, 15, 45] })
    assert.equal(sample.isError, false, textOf(sample))
    assert.deepEqual(sample.value.result.argv.slice(0, 5), ['sample', '--project', TINY, '--frames', '0,15,45'])
    assert.equal(sample.value.result.argv[6], join(TINY, 'exports', 'dsh', 'sample-0_15_45.png'))

    const render = await callTool(ctx, 'vmotion_render', { project: TINY, start: 0, end: 10, codec: 'h264', resume: false })
    assert.equal(render.isError, false, textOf(render))
    assert.deepEqual(render.value.result.argv, ['render', '--project', TINY, '--output', join(TINY, 'exports', 'render.mp4'), '--format', 'mp4', '--json', '--start', '0', '--end', '10', '--codec', 'h264', '--no-resume'])

    const enc = await callTool(ctx, 'vmotion_encoders', { project: TINY, codecs: ['h264', 'hevc'], bitDepth: 8 })
    assert.deepEqual(enc.value.result.argv, ['encoders', '--project', TINY, '--json', '--codec', 'h264', 'hevc', '--bit-depth', '8'])

    const img = await callTool(ctx, 'vmotion_image_export', { project: TINY, format: 'webp', scale: 2, transparent: true })
    assert.deepEqual(img.value.result.argv, ['image', 'export', '--project', TINY, '--format', 'webp', '--scale', '2', '--transparent'])

    const context = await callTool(ctx, 'vmotion_context', { project: TINY, scene: 'intro', limit: 20 })
    assert.deepEqual(context.value.result.argv, ['context', '--project', TINY, '--json', '--scene', 'intro', '--limit', '20'])

    const doctor = await callTool(ctx, 'vmotion_doctor', {})
    assert.equal(doctor.isError, false)
    assert.equal(doctor.value.version, '9.9.9')
    assert.equal(doctor.value.ok, true)
  } finally { await ctx.fiber.dispose() }
})

test('argument validation fails loudly before spawning', async () => {
  const ctx = await setup(fakeConfig())
  try {
    const cases = [
      ['vmotion_frame', { project: TINY }, /frame/],
      ['vmotion_frame', { project: TINY, frame: 1, width: 320 }, /width and height together/],
      ['vmotion_frame', { project: TINY, frame: -1 }, /non-negative/],
      ['vmotion_sample', { project: TINY, frames: [] }, /1 to 12/],
      ['vmotion_sample', { project: TINY, frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, /1 to 12/],
      ['vmotion_context', { project: TINY, scene: '--evil' }, /must be a non-empty id/],
      ['vmotion_render', { project: TINY, start: 10, end: 5 }, /end must be greater/],
      ['vmotion_render', { project: TINY, encoder: 'nvenc;rm' }, /encoder/],
      ['vmotion_render', { project: TINY, format: 'gif' }, /format|enum|gif/i],
      ['vmotion_validate', { project: join(TINY, 'missing') }, /not found/],
      ['vmotion_validate', { project: ROOT }, /no project\.vmotion\.json/],
    ]
    for (const [name, args, re] of cases) {
      const r = await callTool(ctx, name, args)
      assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} should fail`)
      assert.match(textOf(r) + JSON.stringify(r.error), re, `${name} ${JSON.stringify(args)}`)
    }
  } finally { await ctx.fiber.dispose() }
})

test('exit codes: 2/3 are domain results, 1 is a tool error with the CLI error code', async () => {
  const ctx = await setup(fakeConfig())
  try {
    process.env.FAKE_INVALID = '1'
    const v = await callTool(ctx, 'vmotion_validate', { project: TINY })
    assert.equal(v.isError, false)
    assert.equal(v.value.ok, false)
    assert.equal(v.value.exitCode, 2)
    assert.equal(v.value.result.valid, false)
    assert.match(textOf(v), /JSX_PROP/)
    delete process.env.FAKE_INVALID

    process.env.FAKE_INCOMPLETE = '1'
    const r = await callTool(ctx, 'vmotion_render', { project: TINY })
    assert.equal(r.isError, false)
    assert.equal(r.value.exitCode, 3)
    delete process.env.FAKE_INCOMPLETE

    process.env.FAKE_FAIL = '1'
    const f = await callTool(ctx, 'vmotion_frame', { project: TINY, frame: 0 })
    assert.equal(f.isError, true)
    assert.match(textOf(f), /FAKE_ERROR: fake failure/)
    delete process.env.FAKE_FAIL
  } finally { await ctx.fiber.dispose() }
})

test('missing CLI: tools fail with a configuration hint; doctor reports ok:false', async () => {
  const ctx = await setup({ command: ['/nonexistent/vmotion-cli'] })
  try {
    const r = await callTool(ctx, 'vmotion_validate', { project: TINY })
    assert.equal(r.isError, true)
    assert.match(textOf(r), /vmotion CLI not found.*Config\.command/)
    const d = await callTool(ctx, 'vmotion_doctor', {})
    assert.equal(d.isError, false)
    assert.equal(d.value.ok, false)
    assert.match(textOf(d), /NOT usable/)
  } finally { await ctx.fiber.dispose() }
})

test('env scrubbing drops secrets and DSH_* unless configured explicitly', async () => {
  const env = buildChildEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', DEEPSEEK_TOKEN: 'y', DSH_HOME: '/h', VMOTION_NATIVE: '/n' }, { MY_TOKEN: 'explicit' })
  assert.deepEqual(env, { PATH: '/bin', VMOTION_NATIVE: '/n', MY_TOKEN: 'explicit' })
  process.env.FAKE_API_KEY = 'super-secret'
  const ctx = await setup(fakeConfig())
  try {
    const r = await callTool(ctx, 'vmotion_frame', { project: TINY, frame: 0 })
    assert.equal(r.value.result.secret, null)
  } finally { delete process.env.FAKE_API_KEY; await ctx.fiber.dispose() }
})

test('spawnPlan: no shell on POSIX; Windows .cmd goes through cmd.exe with strict quoting', () => {
  assert.deepEqual(spawnPlan(['vmotion'], ['validate', '--project', '/a b']), { file: 'vmotion', argv: ['validate', '--project', '/a b'], verbatim: false })
  const win = spawnPlan(['C:\\Vmotion\\vmotion.cmd'], ['validate', '--project', 'C:\\My Video'], 'win32')
  assert.equal(win.verbatim, true)
  assert.deepEqual(win.argv.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(win.argv[3], '""C:\\Vmotion\\vmotion.cmd" "validate" "--project" "C:\\My Video""')
  assert.throws(() => spawnPlan(['x.cmd'], ['%PATH%'], 'win32'), /not allowed/)
  assert.throws(() => spawnPlan([], []), /Config.command/)
})

test('parseJsonOutput tolerates log lines', () => {
  assert.deepEqual(parseJsonOutput('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonOutput('compiling…\n{\n "a": 2\n}\n'), { a: 2 })
  assert.equal(parseJsonOutput(''), null)
  assert.equal(parseJsonOutput('not json'), null)
})

function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return true; await new Promise(r => setTimeout(r, 50)) }
  return false
}

test('timeout stops the CLI and its grandchildren', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmdsh-'))
  const pidfile = join(dir, 'grandchild.pid')
  const started = Date.now()
  await assert.rejects(runCli({
    command: [process.execPath, FAKE], args: ['frame'], cwd: dir,
    env: { ...process.env, FAKE_HANG: '1', FAKE_PIDFILE: pidfile },
    timeoutMs: 1500, signal: new AbortController().signal, maxOutputBytes: 1 << 20, killGraceMs: 500,
  }), (e) => e.code === 'TIMEOUT')
  assert.ok(Date.now() - started < 8000)
  assert.ok(await waitFor(() => existsSync(pidfile)))
  const gpid = Number(await readFile(pidfile, 'utf8'))
  assert.ok(await waitFor(() => !alive(gpid)), 'grandchild killed with the process group')
})

test('cancellation through exec.signal aborts a running tool call and kills the process group', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmdsh-'))
  const pidfile = join(dir, 'grandchild.pid')
  process.env.FAKE_HANG = '1'
  process.env.FAKE_PIDFILE = pidfile
  const ctx = await setup(fakeConfig({ killGraceMs: 500 }))
  try {
    const ac = new AbortController()
    const pending = callTool(ctx, 'vmotion_render', { project: TINY }, ac.signal)
    assert.ok(await waitFor(() => existsSync(pidfile)), 'render started')
    const gpid = Number(await readFile(pidfile, 'utf8'))
    ac.abort()
    const r = await pending
    assert.equal(r.isError, true)
    assert.match(JSON.stringify(r.error) + textOf(r), /ABORT|cancel/i)
    assert.ok(await waitFor(() => !alive(gpid)), 'grandchild killed on cancel')
  } finally {
    delete process.env.FAKE_HANG; delete process.env.FAKE_PIDFILE
    await ctx.fiber.dispose()
  }
})

test('unloading the plugins removes the skill and tools (Cordis effects)', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
  const Tools = (await import('@deepseek-ai/dsh-tools')).default
  const Skills = (await import('@deepseek-ai/dsh-skill')).default
  const c = new Context()
  try {
    await c.plugin(SystemPrompt); await c.plugin(Tools); await c.plugin(Skills)
    const sf = c.plugin(skillPlugin); await sf
    const tf = c.plugin(toolsPlugin, fakeConfig()); await tf
    assert.ok((await c.skills.list()).some(s => s.name === 'vmotion'))
    assert.equal((await callTool(c, 'vmotion_doctor', {})).isError, false)
    await sf.dispose(); await tf.dispose()
    assert.ok(!(await c.skills.list()).some(s => s.name === 'vmotion'), 'skill removed on unload')
    assert.ok(!c.tools.schemas().some(s => s.name.startsWith('vmotion_')), 'tools removed on unload')
    assert.equal((await callTool(c, 'vmotion_doctor', {})).isError, true)
  } finally { await c.fiber.dispose() }
})
