// @ts-check
/**
 * vmotion-dsh: DeepSeek Harness bundle for Vmotion.
 *
 * The bundle patch mounts two plugins: `vmotion-dsh/skill` (packaged agent
 * skill, needs `skills`) and `vmotion-dsh/tools` (CLI-backed tools, needs
 * `tools`). They are separate rows so a composition without one service still
 * gets the other. This entry re-exports both for programmatic use.
 * @module vmotion-dsh
 */
export * as skill from './lib/skill.js'
export * as tools from './lib/tools.js'
