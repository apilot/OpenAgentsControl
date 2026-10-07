<!-- Context: openagents-repo/standards/subagent-structure | Priority: critical | Version: 1.0 | Updated: 2026-01-31 -->
# Standard: Subagent File Structure

**Purpose**: Standard structure for subagent files  
**Priority**: CRITICAL - Load this before creating subagent files

---

## File Template

```markdown
---
description: Brief description
mode: subagent
# V2: permissions is an ordered list of {action, resource, effect} rules.
# Do NOT use a `name:` key — it is V1 legacy and in OpenCode v2.0.24 it breaks
# permissions resolution (rules get swallowed into request.body and ignored).
# The agent name is its path-style ID. Legacy fields (temperature, tools,
# permission map) are not used either.
permissions: [...]
---

# AgentName
> **Mission**: One-sentence mission

<rule id="rule_name">Rule description</rule>

<context>
  <system>Role in pipeline</system>
  <domain>Expertise area</domain>
  <task>What agent does</task>
  <constraints>Limitations</constraints>
</context>

<tier level="1" desc="Critical">
  - @rule_id: Description
</tier>

## Workflow
### Step 1: Preparation
### Step 2: Execution
### Step 3: Output

## Output Format
```yaml
status: "success" | "failure"
```
```

---

## Section Details

### 1. Frontmatter
- ONLY valid OpenCode fields (see agent-frontmatter.md)
- No duplicate keys, orphaned items, or invalid fields

### 2. Header + Mission
```markdown
# TestEngineer
> **Mission**: Author tests following TDD — grounded in project standards.
```

### 3. Critical Rules (3-5 max)
```markdown
<rule id="context_first">ALWAYS call ContextScout BEFORE writing tests.</rule>
<rule id="positive_and_negative">EVERY behavior needs positive AND negative tests.</rule>
```

### 4. Context
```markdown
<context>
  <system>Code quality gate</system>
  <domain>Code review, security, quality</domain>
  <task>Review code against standards</task>
  <constraints>Read-only, no modifications</constraints>
</context>
```

### 5. Execution Tiers
```markdown
<tier level="1" desc="Critical">
  - @context_first: Load context first
</tier>
<tier level="2" desc="Core">
  - Load standards
  - Analyze code
</tier>
<conflict_resolution>Tier 1 overrides Tier 2/3</conflict_resolution>
```

---

## Tool Permission Patterns

### Read-Only (Reviewers, Analyzers)
```yaml
# V2: `edit` covers edit/write/patch; `shell` replaces V1 `bash`; `subagent` replaces V1 `task`.
permissions:
  - {action: shell, resource: "*", effect: deny}
  - {action: edit, resource: "*", effect: deny}
  - {action: subagent, resource: "*", effect: deny}
  - {action: subagent, resource: "subagents/core/contextscout", effect: allow}
```

### Write-Enabled (Coders, Testers)
```yaml
# V2: whitelist without catch-all shell deny — unlisted commands ask (V2 default).
permissions:
  - {action: shell, resource: "npm test *", effect: allow}
  - {action: shell, resource: "git status *", effect: allow}
  - {action: shell, resource: "sudo *", effect: deny}
  - {action: edit, resource: "**/*.env*", effect: deny}
  - {action: edit, resource: "**/*.key", effect: deny}
  - {action: subagent, resource: "*", effect: deny}
  - {action: subagent, resource: "subagents/core/contextscout", effect: allow}
```

### Restricted Shell (Task Managers)
```yaml
permissions:
  - {action: shell, resource: "bash .opencode/skills/task-management/router.sh *", effect: allow}
  - {action: shell, resource: "mkdir -p .tmp/tasks *", effect: allow}
```

---

## File Organization

```
.opencode/agent/subagents/
├── code/           # tester, reviewer, coder-agent, build-agent
├── core/           # task-manager, contextscout, documentation
├── system-builder/ # agent-generator, command-creator
└── utils/          # image-specialist
```

---

## Validation Checklist

- [ ] Valid OpenCode frontmatter (no extra fields)?
- [ ] Mission statement present?
- [ ] 3-5 critical rules with unique IDs?
- [ ] Context section complete?
- [ ] Execution tiers defined with conflict resolution?
- [ ] Workflow steps clear and actionable?
- [ ] Output format specified?
- [ ] Tool permissions appropriate for role?
- [ ] File in correct category directory?
- [ ] No YAML syntax errors?

---

## Common Patterns

**Context-First Pattern**:
```markdown
<rule id="context_first">
  ALWAYS call ContextScout BEFORE starting work. Load relevant standards first.
</rule>
```

**Read-Only Pattern**:
```markdown
<rule id="read_only">
  Read-only agent. NEVER use write, edit, or bash. Provide suggestions only.
</rule>
```

**Security Pattern**:
```yaml
permissions:
  - {action: edit, resource: "**/*.env*", effect: deny}
  - {action: edit, resource: "**/*.key", effect: deny}
  - {action: edit, resource: "**/*.secret", effect: deny}
```

---

## Examples

**See existing subagents**:
- `.opencode/agent/subagents/code/tester.md` - Write-enabled with tests
- `.opencode/agent/subagents/code/reviewer.md` - Read-only reviewer
- `.opencode/agent/subagents/core/task-manager.md` - Restricted bash

---

## Related

- **Frontmatter**: `standards/agent-frontmatter.md`
- **Metadata**: `core-concepts/agent-metadata.md`
- **Adding Agents**: `guides/adding-agent.md`

---

**Last Updated**: 2026-01-31 | **Version**: 1.0.0
