#!/usr/bin/env node
// Fake `vmotion` CLI for argv/exit-code tests. Behaviour:
//   --version            prints 9.9.9
//   FAKE_FAIL=1          exit 1 with {"error":...} on stderr
//   FAKE_INVALID=1       validate exits 2 with {"valid":false,...}
//   FAKE_INCOMPLETE=1    render exits 3
//   FAKE_HANG=1          spawns a grandchild (pid written to FAKE_PIDFILE) and hangs
//   otherwise            echoes argv, cwd and selected env as JSON
import { spawn } from 'node:child_process'
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('9.9.9'); process.exit(0) }
if (process.env.FAKE_FAIL === '1') {
  process.stderr.write(JSON.stringify({ error: { code: 'FAKE_ERROR', message: 'fake failure' } }) + '\n')
  process.exit(1)
}
if (argv[0] === 'validate' && process.env.FAKE_INVALID === '1') {
  console.log(JSON.stringify({ valid: false, diagnostics: [{ severity: 'error', code: 'JSX_PROP', message: 'bad prop' }] }))
  process.exit(2)
}
if (argv[0] === 'render' && process.env.FAKE_INCOMPLETE === '1') {
  console.log(JSON.stringify({ status: 'failed' }))
  process.exit(3)
}
if (process.env.FAKE_HANG === '1') {
  const child = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(process.env.FAKE_PIDFILE ?? '/dev/null')}, String(process.pid)); setInterval(() => {}, 1000)`], { stdio: 'ignore' })
  child.unref()
  setInterval(() => {}, 1000)
} else {
  console.log(JSON.stringify({ argv, cwd: process.cwd(), secret: process.env.FAKE_API_KEY ?? null, extra: process.env.VMOTION_EXTRA ?? null }))
}
