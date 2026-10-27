// @ts-check
/**
 * Packaged `vmotion` agent skill for DeepSeek Harness.
 *
 * Registers one `bundled` skill provider on `ctx.skills` (the same shape as the
 * official `@deepseek-ai/dsh-skill-badge`). The body is read from
 * `assets/skills/vmotion/SKILL.md` on every `get()`, so the Markdown file stays
 * the single source of truth; its `references/` and `examples/` are exposed
 * through `resourceBase` and loaded by the model only when it needs them.
 * @module vmotion-dsh/skill
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'

/** Directory holding SKILL.md, references/ and examples/. */
export const SKILL_DIR = fileURLToPath(new URL('../assets/skills/vmotion/', import.meta.url))
const SKILL_FILE = new URL('../assets/skills/vmotion/SKILL.md', import.meta.url)

/**
 * Split `---` frontmatter (flat `key: value` lines only) from a SKILL.md body.
 * @param {string} text - SKILL.md contents.
 * @returns {{ meta: Record<string, string>, body: string }} parsed parts.
 */
export function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { meta: {}, body: text }
  /** @type {Record<string, string>} */
  const meta = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv !== null && kv[1] !== undefined) meta[kv[1]] = (kv[2] ?? '').trim()
  }
  return { meta, body: text.slice(match[0].length) }
}

// Catalog metadata is read once at load; a broken asset fails the plugin load loudly.
const { meta } = parseSkillFile(readFileSync(SKILL_FILE, 'utf8'))
if (meta.name !== 'vmotion' || !meta.description) throw new Error(`vmotion-dsh: ${fileURLToPath(SKILL_FILE)} must declare name: vmotion and a description`)

const PROVIDER_NAME = 'vmotion-dsh'
const RESOURCE_BASE = /** @type {const} */ ({ kind: 'directory', path: SKILL_DIR })
const INVOCATION = /** @type {const} */ ({ modelInvocable: true, userInvocable: true })

/** @type {import('@deepseek-ai/dsh-skill').SkillCandidate} */
const CANDIDATE = {
  name: meta.name,
  description: meta.description,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  path: fileURLToPath(SKILL_FILE),
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_FILE.href,
}

/** @type {import('@deepseek-ai/dsh-skill').SkillProvider} */
export const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate, options) {
    const text = await readFile(SKILL_FILE, { encoding: 'utf8', signal: options.signal })
    const { body } = parseSkillFile(text)
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      path: CANDIDATE.path,
      resourceBase: RESOURCE_BASE,
      content: body,
    }
  },
}

/** Cordis plugin name. */
export const name = 'vmotion-dsh-skill'
/** No configuration; exported so config tooling reports a schema instead of unknown fields. */
export const Config = Schema.object({})
/** The skill registry must exist before the provider registers. */
export const inject = ['skills']

/**
 * Register the packaged provider. Registration is a Cordis effect, so
 * unloading the plugin removes the skill.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
}
