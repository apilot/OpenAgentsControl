# OpenAgents Control Roadmap

> **Interactive Board:** [GitHub Project - OpenAgents Control Roadmap & Tasks](https://github.com/users/darrenhinde/projects/2)
> **Fork status (2026-10):** upstream darrenhinde/OpenAgentsControl is effectively unmaintained. Active development happens in this fork.

This roadmap tracks the evolution of OpenAgents Control - an AI agent framework for plan-first development workflows with approval-based execution.

---

## 🎯 Now (Current Focus)

**Priority items for the next 4-6 weeks:**

- [x] Stabilize OpenCode CLI integration
- [x] Improve evaluation framework reliability
- [ ] **Phase 1 — evidence-based task completion**: machine-verified `verify` step in task-cli (command/file checks, fresh reports), `complete` gated on fresh verify, dependency graph computed from verified completions only
- [ ] **Phase 2 — opencode v2 enforcement plugin**: port plugin-abilities entry points to the v2 plugin API (`Plugin.define`, `ctx.tool.hook("execute.before")`, `ctx.permission.rules`, `ctx.storage`); eliminate ability entry-point bypass
- [ ] Enhance documentation for new users
- [ ] Add more example workflows

**Phase 0 — fork stabilization (completed 2026-10-01):** cherry-picked upstream PR fixes #296 (plugin-abilities hardening + plugin.json registration), #354 (wildcard permission denies as fallbacks), #311 (eval default model), #358 (installer bash 3.2 compat), #297 (custom install failures + agent-metadata); surgical port of #359's intent (registry data quality + linter with tests). Validation: tsc clean, bun test 89/89 + 16/16 registry linter tests, bash -n, installer smoke tests.

Key architectural finding: **V1 plugin implementations do not run in OpenCode v2.** All existing plugins (plugin-abilities, agent-validator, coder-verification) require porting to the v2 plugin API. Agent/command/skill markdown files and `.opencode/` configs remain compatible.

---

## 🔜 Next (Coming Soon)

**Planned for the following 6-8 weeks:**

- [ ] Support for additional AI coding tools (Cursor, Claude Code, pi.dev/OpenClaw adapters)
- [ ] Enhanced context-aware system builder
- [ ] Multi-language template improvements
- [ ] Community contribution guidelines

---

## 🔭 Later (Exploration)

**Ideas and explorations for future consideration:**

- [ ] Visual workflow designer
- [ ] Agent marketplace/registry
- [ ] Cloud-based agent coordination (GNAP git-native coordination, #273)
- [ ] **Phase 3 candidates** (from pi.dev security/containerization practices): project-trust gate for `.opencode/plugins` loading; sandboxed ability script-steps (Docker/Gondolin-style tool-only isolation instead of host shell); credential proxy for the e2e harness
- [ ] Integration with popular IDEs

---

## 📝 How to Use This Roadmap

### View the Interactive Board
Visit the [GitHub Project](https://github.com/users/darrenhinde/projects/2) to see:
- Current status of all items
- Priority levels
- Detailed descriptions
- Progress tracking

### Suggest Ideas
Create an issue with the `idea` label:
```bash
gh issue create \
  --repo darrenhinde/OpenAgentsControl \
  --title "Your idea title" \
  --body "Description of your idea..." \
  --label "idea"
```

### Track Progress
```bash
# List all ideas
gh issue list --repo darrenhinde/OpenAgentsControl --label idea

# View specific issue
gh issue view 123 --repo darrenhinde/OpenAgentsControl
```

---

## 🏷️ Labels Used

- **idea** - High-level proposals and feature ideas
- **feature** - New features or enhancements
- **bug** - Bug fixes and issues
- **docs** - Documentation improvements
- **agents** - Agent system related
- **evals** - Evaluation framework
- **framework** - Core framework changes

---

**Last Updated:** October 1, 2026

