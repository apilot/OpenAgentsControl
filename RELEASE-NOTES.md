# Release Notes — OpenAgents Control (Community Fork)

**Base:** upstream `darrenhinde/OpenAgentsControl` @ `37ca233` (2026-07-15)
**This fork:** 24 commits, 61 files, +9,115 / −251 lines · 182 tests · Docker clean-room E2E: FULL PASS

> Upstream is no longer actively maintained. This fork continues development with a focus
> on **trustworthy agent execution**: machine-verified completion, live tool enforcement,
> and full OpenCode v2 support.

---

## ⭐ Headline: Full OpenCode v2 Support

OpenCode v2 ships an intentionally **breaking plugin API** ("V1 plugin implementations do
not run in V2"). This fork is the first OAC distribution that supports it:

- **New v2 plugin** (`@opencode/plugin@2.0.21` contract): `Plugin.define` with
  `ctx.tool.hook("execute.before")`, `ctx.permission.hook("evaluate")` (mutable effect →
  deny), `ctx.session.hook("context")` (enforcement notices), `ctx.storage` (durable
  active-execution state + crash recovery).
- **Graceful per-domain degradation** — on hosts that expose only part of the v2 API
  (e.g. the current v2 preview lacks tool/permission/session/storage domains), the plugin
  disables exactly the missing layers with a loud warning instead of dying silently.
- **Dual contract ready**: the v1 engine entry point is kept and live-proven; the v2
  plugin preserves identical semantics (same enforcement window, same denial messages).
- Verified in a Docker clean room against real `opencode` (v1 engine, which loads file
  plugins) and `opencode2` (v2 preview) — see `evals/e2e-v2/`.

### Advantages over the old version

| Area | Old (upstream) | This fork |
|---|---|---|
| Task completion | Self-reported by the agent ("trust me") | **Machine-verified**: `verification` checks must pass, evidence report written |
| Tool enforcement during abilities | Declared in docs, but a code bug made it a no-op | **Live-proven**: parallel bypass attempts are denied in real opencode runs |
| Agent/step cancellation | Child processes survived abort | Process tree killed (SIGTERM→SIGKILL), timeouts enforced |
| Stage (orchestration) completion | Self-reported | Evidence gate + prerequisite gates |
| Broken deps | Task silently completed | Fail-closed with explicit error |
| Unverified completion | The only path | Opt-in (`--allow-unverified`) with SELF-REPORTED warning |
| Installer | Broken on macOS bash 3.2 / custom dirs | Fixed + hardened (validation, escaping) |
| v2 compatibility | None (V1 plugins die in v2) | Full dual support |

---

## 🔾 New Functionality

### 1. Evidence-based task completion (task schema v2.1)
Every subtask may declare machine-executable `verification` checks:

```json
"verification": [
  { "type": "command", "command": "npx tsc --noEmit" },
  { "type": "file_exists", "path": "src/auth.ts" },
  { "type": "file_contains", "path": "src/auth.ts", "expect_contains": "export function login" }
]
```

- `task-cli verify <feature> <seq>` — run checks on demand, write `verification_{seq}.json`.
- `task-cli complete ...` — **refuses** to complete while any check fails; evidence report
  is always fresh (generated at completion time). Backward compatible: legacy tasks without
  the block require an explicit `--allow-unverified` flag and are marked SELF-REPORTED.
- Dependency gating (`next` / `blocked` / `parallel`) now inherits only verified completions.
- Schema validation covers the new block (`task-cli validate`); ids are strictly validated,
  writes are atomic (temp+rename).

### 2. Live enforcement plugin (abilities)
While an ability script step runs, everything except whitelisted read-only tools is blocked:

- **Layer 1** — `tool.execute.before` throws a denial (tool never runs).
- **Layer 2** — `permission.evaluate` mutates the effect to `deny` (covers child sessions on v2).
- A "⚠️ ENFORCEMENT ACTIVE" notice is injected into the conversation context.
- **Crash recovery**: a dangling running execution is marked `interrupted` on restart
  (durable storage mirror).
- **Fail-closed policy**: internal enforcement errors deny the call instead of allowing it
  (`strict: false` opts into fail-open).
- Ability tools (`ability.list/run/status/cancel`) are registered through the v2 tool
  registry (`ctx.tool.transform`).

Proven live: in a real `opencode run` with GLM-5.3-flash, the model attempted a parallel
`bash` bypass during a script step — the call errored with
`[abilities] Tool 'bash' blocked during script step 'wait'…` while the ability ran to
completion, and the same bash succeeded after completion (correct A1 release semantics).

### 3. Stage-level evidence gate (orchestration)
`stage-cli complete` now runs the same class of machine checks on stage outputs (path/glob
artifacts, `{feature}` substitution), refuses on missing evidence, validates feature names,
matches session dirs exactly (no `test` / `my-test` collisions), and blocks `resume` into
stages whose prerequisites are incomplete. Prose-only stages complete with an explicit
"NOT evidence-backed" warning.

### 4. Agent workflow integration
`task-manager`, `coder-agent` and `batch-executor` now author verification blocks as part of
task planning, run `verify` before signalling completion, and BatchExecutor treats
`verification_{seq}.json` as the evidence source instead of trusting agent signals.

### 5. Repo map tool (`scripts/development/repo-map.sh`)
Fast whole-repo symbol map (Aider-style): universal-ctags JSON backend (or pure-regex grep
fallback with zero dependencies), symbol ranking per file, `fzf` interactive pick with
preview, `ensure-deps` installer helper (apt/brew/dnf/pacman). Data files (lockfiles, JSON)
are excluded; output contains only real code symbols with line numbers.

### 6. Docker clean-room E2E (`evals/e2e-v2/`)
One command (`run.sh`) builds/reuses an image and validates the entire product in an
isolated container: fresh repo copy → full test suites → fixture project → **live
enforcement scenario with a real LLM** (z.ai key passed via env) → task-gate scenario →
verdict report with automatic key masking. Repo is mounted read-only; provider keys never
land in the host-visible report.

---

## 🔧 Fixes over the old version

- **Abilities executor**: `cancel()` now kills the whole child process tree (previously
  children survived abort); `step.timeout` is honored; unresolvable step dependencies fail
  loudly instead of silently completing; unknown `when` conditions fail closed.
- **Enforcement actually works**: upstream's execution manager never mirrored the current
  step (`currentStep` was always `null`), so v1 tool-blocking was effectively dead code —
  fixed with live progress mirroring (+ regression test).
- **plugin.json**: 12 skills + 6 commands registered (upstream shipped them unregistered).
- **install.sh**: macOS bash 3.2 compatibility, custom-install routing/counter/trap fixes,
  missing agent-metadata component, arg validation, sed escaping, `mktemp` fallback.
- **registry.json**: cleaned generator artifacts, fixed dead profile wildcards, component
  id consistency; new **registry linter** (schema, dependency graph, cycles, dangling refs,
  profile references) with test suite.
- **Router/CLI invocations**: all `npx ts-node` call paths replaced (broken on node ≥ 20)
  with a bun-first runner; stale duplicates removed.
- **Docs**: ROADMAP refreshed (fork status, Phase 3 candidates from pi.dev/Claude Code/
  Codex/Aider/DSH analysis: project-trust gate, sandboxed script steps, credential proxy).

---

## ✅ Quality Gates

| Gate | Result |
|---|---|
| plugin-abilities suite | 127 tests ✅ |
| repo suites (registry linter, task gate, stage gate, repo-map) | 55 tests ✅ |
| TypeScript strict (`tsc --noEmit`) | clean ✅ |
| Docker clean-room E2E (incl. live LLM enforcement) | FULL PASS, 0 failures ✅ |
| Every fix paired with tests | yes ✅ |

## Compatibility

- **OpenCode v1 (1.18.x)**: fully supported — plugins load from `.opencode/plugins/`
  (wrapper contract `{id, server}`).
- **OpenCode v2**: supported through the new v2 plugin; the current v2 *preview* exposes a
  reduced context, so missing domains degrade gracefully with warnings until the stable v2
  ships them.
- **Task JSON schemas**: v1.0 / v2.0 files remain valid; verification is opt-in (v2.1).
