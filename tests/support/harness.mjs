// In-memory Cordis composition for LLM-free tests: the real DSH tool registry
// and skill registry from the installed runtime, plus this bundle's plugins.
import './dsh-hooks.mjs'
import { randomUUID } from 'node:crypto'

const { Context } = await import('@deepseek-ai/cordis')
const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
const ToolsModule = await import('@deepseek-ai/dsh-tools')
const SkillRegistry = (await import('@deepseek-ai/dsh-skill')).default
export const skillPlugin = await import('../../lib/skill.js')
export const toolsPlugin = await import('../../lib/tools.js')

/**
 * Build a context with tools + skills services and both vmotion plugins.
 * @param {object} [toolsConfig] - vmotion-tools row config.
 */
export async function setup(toolsConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsModule.default)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(skillPlugin)
  await ctx.plugin(toolsPlugin, toolsConfig)
  return ctx
}

/**
 * Execute one registered tool through the registry pipeline (argument
 * validation, output-schema validation, rendering) without any model.
 * Supports the npm 0.2.x single-call `ctx.tools.execute(input)` contract and
 * master's batch `ctx.tools.execute({ calls })` contract.
 */
export async function callTool(ctx, name, args, signal = new AbortController().signal) {
  const callId = `call-${randomUUID()}`
  const out = await ctx.tools.execute({ callId, name, arguments: args, signal })
  if (out && Array.isArray(out.results)) return out.results[0].result
  return out
}

export function textOf(result) {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}
