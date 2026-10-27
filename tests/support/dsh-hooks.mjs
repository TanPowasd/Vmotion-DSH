// Test-only module hooks: resolve `@deepseek-ai/*` imports from the installed
// DSH runtime, the way DSH's profile resolution serves a linked bundle's peer
// dependencies from the running installation. Set DSH_INSTALL_DIR to the
// directory of the `@deepseek-ai/dsh` package; otherwise it is derived from
// the `dsh` executable on PATH.
import { registerHooks } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function findInstallDir() {
  if (process.env.DSH_INSTALL_DIR) return process.env.DSH_INSTALL_DIR
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const bin = join(dir, 'dsh')
    if (!existsSync(bin)) continue
    // <prefix>/bin/dsh -> <pkg>/lib/bin.js
    return dirname(dirname(realpathSync(bin)))
  }
  throw new Error('vmotion-dsh tests: cannot locate the DSH installation; install @deepseek-ai/dsh or set DSH_INSTALL_DIR')
}

export const DSH_INSTALL_DIR = findInstallDir()
const parentURL = pathToFileURL(join(DSH_INSTALL_DIR, 'package.json')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, { ...context, parentURL })
    return nextResolve(specifier, context)
  },
})
