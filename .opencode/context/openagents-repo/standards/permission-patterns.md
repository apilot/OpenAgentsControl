<!-- Context: openagents-repo/standards/permission-patterns | Priority: critical | Version: 2.0 | Updated: 2026-10-07 -->
# Standard: Permission Patterns for OpenCode V2

**Purpose**: Comprehensive permission configuration patterns for different agent types  
**Priority**: CRITICAL - Load this before configuring agent permissions

---

## Core Principle

OpenCode V2 uses `permissions:` (plural) — an **ordered list** of rules with three string fields:

```yaml
permissions:
  - action: shell
    resource: "git push *"
    effect: deny
```

| Field | Meaning |
|-------|---------|
| `action` | Tool permission action (`shell`, `edit`, `subagent`, …) |
| `resource` | Matched value: path, command, URL, skill ID, agent ID |
| `effect` | `allow`, `ask`, or `deny` |

**Why**: Granular permissions prevent unintended actions while allowing necessary operations.

---

## Evaluation Rules (V2)

1. **Last matching rule wins** — put broad rules FIRST, specific exceptions AFTER.
2. **No match → `ask`** (not deny).
3. Every agent starts from the base policy: allow-all, plus `ask` for
   `external_directory` and `.env` file reads.
4. A shell pattern ending in ` *` also matches the command **without arguments**
   (`"git status *"` matches both `git status` and `git status --short`).
5. A custom subagent uses **its own permissions**, not a subset of its parent's.
6. Operations may check several resources (e.g. a multi-file patch): any `deny`
   denies, otherwise any `ask` asks, otherwise allow.

```yaml
# Broad rule first, exceptions after (last match wins):
permissions:
  - action: shell
    resource: "*"
    effect: ask
  - action: shell
    resource: "git status *"
    effect: allow
  - action: shell
    resource: "git push *"
    effect: deny
```

---

## Valid Actions and Resources (V2)

| Action | Resource |
|--------|----------|
| `read` | File path |
| `edit` | Target path — **covers `edit`, `write`, and `patch` tools** |
| `glob` | Requested glob pattern |
| `grep` | Requested regular expression |
| `shell` | Command string (was `bash` in V1) |
| `subagent` | Target agent ID (was `task` in V1) |
| `skill` | Skill ID |
| `question` | `*` |
| `webfetch` | Requested URL |
| `websearch` | Search query |
| `external_directory` | Canonical external directory (normally `…/*`) |
| `execute` | `*` — controls Code Mode availability |

V1 → V2 renames: `bash` → `shell`, `task` → `subagent`, `permission:` → `permissions:`.
Legacy top-level fields **not used in V2**: `temperature`, `top_p`, `prompt`,
`permission`, `tools`, `disable`, `maxSteps`.

---

## Agent Type Patterns

### Read-Only Agents (Reviewers, Analyzers)

**Use case**: Code review, analysis, security audits

```yaml
permissions:
  - action: shell
    resource: "*"
    effect: deny
  - action: edit
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: "subagents/core/contextscout"
    effect: allow
```

**Examples**: CodeReviewer, SecurityAuditor

---

### Whitelist Agents (Testers, Builders)

**Use case**: Agents that may run only specific commands.

```yaml
permissions:
  # Allowlist only — NO catch-all shell deny.
  # In V2 unlisted commands fall back to `ask`; a `"*": deny` catch-all
  # can hide the shell tool entirely for custom subagents.
  - action: shell
    resource: "npx vitest *"
    effect: allow
  - action: shell
    resource: "pytest *"
    effect: allow
  - action: shell
    resource: "rm -rf *"
    effect: ask
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: edit
    resource: "**/*.env*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: "subagents/core/contextscout"
    effect: allow
```

**Examples**: TestEngineer, BuildAgent, CoderAgent

> **Compromise note**: migrating a V1 `"*": "deny"` shell catch-all to V2 changes
> the fallback for unlisted commands from `deny` to `ask`. This is deliberate —
> the catch-all removed the shell tool entirely in v2.0.24. If hard-deny semantics
> are required, add the catch-all explicitly and verify the tool stays available.

---

### Orchestrators (Task Managers, Primary Agents)

**Use case**: Workflow orchestration, task delegation

```yaml
permissions:
  - action: shell
    resource: "*"
    effect: ask
  - action: shell
    resource: "rm -rf /*"
    effect: deny
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: edit
    resource: "**/*.env*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: allow
```

**Examples**: OpenCoder, OpenAgent, TaskManager

---

## Security Patterns

### Always Deny Sensitive Files

```yaml
permissions:
  - action: edit
    resource: "**/*.env*"
    effect: deny
  - action: edit
    resource: "**/*.key"
    effect: deny
  - action: edit
    resource: "**/*.secret"
    effect: deny
```

Note: the V2 base policy already asks before reading `.env` files; explicit
edit-deny rules block writing them.

### Always Deny Dangerous Commands

```yaml
permissions:
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: shell
    resource: "rm -rf /*"
    effect: deny
```

### Always Ask for Destructive Operations

```yaml
permissions:
  - action: shell
    resource: "rm -rf *"
    effect: ask
  - action: shell
    resource: "git push --force *"
    effect: ask
  - action: shell
    resource: "npm publish *"
    effect: ask
```

---

## Subagent Permission Patterns

Agent IDs are path-style in nested directories
(`.opencode/agent/subagents/core/contextscout.md` → `subagents/core/contextscout`).

### Allow Specific Subagents Only

```yaml
permissions:
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: "subagents/core/contextscout"
    effect: allow
  - action: subagent
    resource: "subagents/core/externalscout"
    effect: allow
```

### Allow All Except Specific

```yaml
permissions:
  - action: subagent
    resource: "subagents/legacy-agent"
    effect: deny
```

(Unlisted subagents are already allowed by the base policy — no catch-all needed.)

---

## Complete Examples

### Example 1: Code Reviewer (Read-Only)

```yaml
---
description: Code review, security, and quality assurance agent
mode: subagent
permissions:
  - action: shell
    resource: "*"
    effect: deny
  - action: edit
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: "subagents/core/contextscout"
    effect: allow
---
```

### Example 2: Test Engineer (Whitelist)

```yaml
---
description: Test authoring and TDD agent
mode: subagent
permissions:
  - action: shell
    resource: "npx vitest *"
    effect: allow
  - action: shell
    resource: "pytest *"
    effect: allow
  - action: shell
    resource: "rm -rf *"
    effect: ask
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: edit
    resource: "**/*.env*"
    effect: deny
  - action: edit
    resource: "**/*.key"
    effect: deny
  - action: edit
    resource: "**/*.secret"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: "subagents/core/contextscout"
    effect: allow
---
```

### Example 3: Primary Orchestrator

```yaml
---
description: Orchestration agent for complex coding
mode: primary
permissions:
  - action: shell
    resource: "rm -rf *"
    effect: ask
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: edit
    resource: "**/*.env*"
    effect: deny
  - action: edit
    resource: ".git/**"
    effect: deny
---
```

---

## Validation Checklist

- [ ] Using `permissions:` (plural, ordered **list**) — V2; `permission:` maps are V1 legacy
- [ ] **NO `name:` key in frontmatter** — V1 legacy; in v2.0.24 it breaks permissions resolution
- [ ] Actions renamed: `shell` (not `bash`), `subagent` (not `task`)
- [ ] Broad rules FIRST, specific exceptions AFTER (last match wins)
- [ ] No legacy top-level fields (`temperature`, `tools`, `disable`, `maxSteps`, `top_p`, `prompt`)
- [ ] Sensitive files denied (`**/*.env*`, `**/*.key`, `**/*.secret`)
- [ ] Dangerous commands denied (`sudo *`, `rm -rf /*`)
- [ ] Destructive operations ask (`rm -rf *`, `git push --force *`)
- [ ] Whitelist agents: no catch-all `shell "*": deny` (fallback is `ask` anyway)
- [ ] Subagent IDs are path-style (`subagents/core/contextscout`)
- [ ] Valid effects only (`allow`, `ask`, `deny`)

---

## Related

- **Subagent Structure**: `standards/subagent-structure.md`
- **Security Patterns**: `../../core/standards/security-patterns.md`
- **OpenCode V2 Docs**: https://opencode.ai/v2/docs/permissions/

---

**Last Updated**: 2026-10-07 | **Version**: 2.0.0
