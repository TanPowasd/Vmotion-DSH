// @ts-check
/**
 * Spawn the `vmotion` CLI with a fixed argv (never through a shell on POSIX),
 * bounded output capture, a hard deadline and caller cancellation.
 *
 * On POSIX the child gets its own process group so cancellation also stops the
 * native core / FFmpeg grandchildren `vmotion render` starts. On Windows the
 * tree is killed with `taskkill /T /F` (not verified in this repository's CI).
 * @module vmotion-dsh/run-cli
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

/** Ambient variable names that must not reach the CLI unless configured explicitly (same rule as dsh-mcp-client stdio). */
const SECRET_NAME = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Build the child environment: ambient env minus secrets and `DSH_*`, then the configured overrides.
 * @param {Record<string, string | undefined>} ambient - usually `process.env`.
 * @param {Record<string, string>} overrides - `Config.env`.
 * @returns {Record<string, string>} the environment handed to the child.
 */
export function buildChildEnv(ambient, overrides) {
  /** @type {Record<string, string>} */
  const env = {}
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue
    if (SECRET_NAME.test(name) || name.startsWith('DSH_')) continue
    env[name] = value
  }
  return { ...env, ...overrides }
}

/** Error raised when the CLI could not be started or stopped normally. */
export class VmotionCliError extends Error {
  /**
   * @param {string} message - human readable reason.
   * @param {string} code - stable code: ENOENT, TIMEOUT, ABORTED, SPAWN.
   */
  constructor(message, code) {
    super(message)
    this.name = 'VmotionCliError'
    this.code = code
  }
}

/**
 * Quote one argument for `cmd.exe /s /c "<line>"`. Characters that cmd.exe
 * would expand or treat as operators even inside quotes are rejected.
 * @param {string} arg - one argv element.
 * @returns {string} the quoted argument.
 */
function quoteForCmd(arg) {
  if (/["%!^\r\n]/.test(arg)) throw new VmotionCliError(`argument not allowed when the CLI is a .cmd/.bat wrapper: ${JSON.stringify(arg)}`, 'SPAWN')
  return `"${arg}"`
}

/**
 * Resolve how to spawn `command` on this platform.
 * @param {readonly string[]} command - configured argv prefix, e.g. `['vmotion']`.
 * @param {readonly string[]} args - subcommand arguments.
 * @returns {{ file: string, argv: string[], verbatim: boolean }} spawn plan.
 */
export function spawnPlan(command, args, platform = process.platform) {
  const [file, ...prefix] = command
  if (file === undefined || file === '') throw new VmotionCliError('Config.command must name the vmotion executable', 'SPAWN')
  const all = [...prefix, ...args]
  if (platform === 'win32' && ['.cmd', '.bat'].includes(extname(file).toLowerCase())) {
    // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980); go through cmd.exe explicitly.
    const line = [file, ...all].map(quoteForCmd).join(' ')
    return { file: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
  }
  return { file, argv: all, verbatim: false }
}

/**
 * Locate an executable on PATH (used by the doctor tool only).
 * @param {string} name - executable name or path.
 * @param {Record<string, string>} env - environment whose PATH is searched.
 * @returns {string | undefined} absolute path when found.
 */
export function which(name, env) {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) return existsSync(name) ? name : undefined
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* keep looking */ }
    }
  }
  return undefined
}

/**
 * @typedef {object} RunOptions
 * @property {readonly string[]} command - argv prefix that starts the CLI.
 * @property {readonly string[]} args - subcommand and flags.
 * @property {string} cwd - working directory of the child.
 * @property {Record<string, string>} env - complete child environment.
 * @property {number} timeoutMs - hard deadline.
 * @property {AbortSignal} signal - caller cancellation (the tool's `exec.signal`).
 * @property {number} maxOutputBytes - capture cap per stream.
 * @property {number} killGraceMs - SIGTERM → SIGKILL grace period.
 */

/**
 * @typedef {object} RunResult
 * @property {number} exitCode - process exit code.
 * @property {string} stdout - captured stdout (capped).
 * @property {string} stderr - captured stderr (capped).
 * @property {boolean} truncated - whether either stream hit the cap.
 * @property {number} durationMs - wall time.
 */

/**
 * Run the CLI once.
 * @param {RunOptions} options - spawn options.
 * @returns {Promise<RunResult>} the settled process result.
 * @throws {VmotionCliError} when the process cannot start, times out, or is cancelled.
 */
export function runCli(options) {
  const { command, args, cwd, env, timeoutMs, signal, maxOutputBytes, killGraceMs } = options
  if (signal.aborted) return Promise.reject(new VmotionCliError('cancelled before start', 'ABORTED'))
  const plan = spawnPlan(command, args)
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.argv, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
    })
    /** @type {Buffer[]} */ const out = []
    /** @type {Buffer[]} */ const err = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    /** @type {'TIMEOUT' | 'ABORTED' | undefined} */
    let stopReason
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer

    const collect = (/** @type {Buffer[]} */ sink, /** @type {Buffer} */ chunk, /** @type {number} */ used) => {
      const room = maxOutputBytes - used
      if (room <= 0) { truncated = true; return used }
      if (chunk.length > room) { truncated = true; sink.push(chunk.subarray(0, room)); return maxOutputBytes }
      sink.push(chunk)
      return used + chunk.length
    }
    child.stdout?.on('data', (chunk) => { outBytes = collect(out, chunk, outBytes) })
    child.stderr?.on('data', (chunk) => { errBytes = collect(err, chunk, errBytes) })

    const kill = (/** @type {NodeJS.Signals} */ sig) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else process.kill(-child.pid, sig)
      } catch { /* already gone */ }
    }
    const stop = (/** @type {'TIMEOUT' | 'ABORTED'} */ reason) => {
      if (stopReason !== undefined) return
      stopReason = reason
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }
    const deadline = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    deadline.unref?.()
    const onAbort = () => stop('ABORTED')
    signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(deadline)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => {
      cleanup()
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if (code === 'ENOENT') {
        reject(new VmotionCliError(`vmotion CLI not found: ${JSON.stringify(command)}. Set the vmotion-tools row's Config.command (e.g. ["node", "<Vmotion>/dist/cli/index.mjs"]).`, 'ENOENT'))
      } else {
        reject(new VmotionCliError(`failed to start vmotion CLI: ${error.message}`, 'SPAWN'))
      }
    })
    child.once('close', (exitCode, sig) => {
      cleanup()
      // Make sure no grandchild outlives a cancelled call.
      if (stopReason !== undefined) kill('SIGKILL')
      const durationMs = Date.now() - started
      if (stopReason === 'TIMEOUT') return reject(new VmotionCliError(`vmotion ${args[0] ?? ''} timed out after ${timeoutMs} ms and was stopped`, 'TIMEOUT'))
      if (stopReason === 'ABORTED') return reject(new VmotionCliError(`vmotion ${args[0] ?? ''} was cancelled and stopped`, 'ABORTED'))
      resolve({
        exitCode: exitCode ?? (sig === null ? -1 : 128),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        durationMs,
      })
    })
  })
}

/**
 * Parse CLI stdout. Every project command prints one JSON document; tolerate
 * leading log lines by falling back to the last line that parses.
 * @param {string} text - captured stdout.
 * @returns {unknown} parsed JSON, or `null` when nothing parses.
 */
export function parseJsonOutput(text) {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  const start = trimmed.search(/^[{[]/m)
  if (start > 0) { try { return JSON.parse(trimmed.slice(start)) } catch { /* fall through */ } }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) } catch { /* next */ }
  }
  return null
}
