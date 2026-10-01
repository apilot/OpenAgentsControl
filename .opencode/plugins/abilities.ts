/**
 * OpenCode v2 local plugin wrapper.
 *
 * Thin re-export of the plugin-abilities package source. opencode v2
 * auto-discovers `.opencode/plugins/` and compiles TypeScript itself,
 * so no build step is required and opencode.json needs no entry.
 *
 * Enforcement scope (user-approved A1/B1/C1):
 * - active ONLY while a script step of an ability execution is running
 * - two denial layers: tool.hook("execute.before") throw + permission
 *   hook("evaluate") dynamic deny (covers shell/edit/subagent actions)
 * - fail-closed by default; disable via plugin options { strict: false }
 */
export { default } from '../../packages/plugin-abilities/src/v2-plugin.js'
