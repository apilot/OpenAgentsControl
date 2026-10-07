<!-- Context: openagents-repo/errors | Priority: medium | Version: 1.0 | Updated: 2026-02-15 -->

# Tool Permission Errors

**Purpose**: Diagnose and fix tool permission issues in agents

**Last Updated**: 2026-01-07

---

## Error: Tool Permission Denied

### Symptom

```json
{
  "type": "missing-approval",
  "severity": "error",
  "message": "Execution tool 'bash' called without requesting approval"
}
```

Or agent tries to use a tool but gets blocked silently (0 tool calls).

---

### Cause

Agent has the action **denied** in frontmatter (V2):

```yaml
# In agent frontmatter (V2 permissions list)
permissions:
  - action: shell
    resource: "*"
    effect: deny   # ← Explicitly denied
```

**How it works**:
- A `deny` rule blocks the operation for that agent
- Framework enforces this - agent can't run shell even if prompt says to
- NOT an approval issue - it's a permission restriction
- V1 legacy note: a `permission:` map with `bash:` entries is not understood by
  V2 and can cause the whole shell tool to be stripped from a custom subagent —
  migrate to the V2 `permissions` list

---

### Solution

**Option 1: Emphasize Tool Restrictions in Prompt** (Recommended)

Add critical rules section at top of agent prompt:

```xml
<critical_rules priority="absolute" enforcement="strict">
  <rule id="tool_usage">
    ONLY use: glob, read, grep, list
    NEVER use: bash, write, edit, task
    You're read-only—no modifications allowed
  </rule>
  <rule id="always_use_tools">
    ALWAYS use tools to discover files
    NEVER assume or fabricate file paths
  </rule>
</critical_rules>
```

**Why this works**: Makes tool restrictions crystal clear in first 15% of prompt.

**Option 2: Allow the Action** (If agent needs it)

```yaml
permissions:
  # Whitelist only what the agent truly needs (V2: unlisted commands ask)
  - action: shell
    resource: "bundle exec rspec *"
    effect: allow
```

**Warning**: Only allow what the agent truly needs. Read-only subagents should NOT have shell/edit allows.

---

### Prevention

**For Read-Only Subagents** (V2):

```yaml
# Correct configuration for read-only subagents (V2)
permissions:
  - action: shell
    resource: "*"
    effect: deny    # ← No execution
  - action: edit
    resource: "*"
    effect: deny    # ← No modifications (covers edit, write, patch)
  - action: subagent
    resource: "*"
    effect: deny    # ← No delegation
```

**For Primary Agents** (V2):

```yaml
# Primary agents: base policy allows tools; add targeted guardrails
permissions:
  - action: shell
    resource: "sudo *"
    effect: deny
  - action: shell
    resource: "rm -rf *"
    effect: ask
  - action: edit
    resource: "**/*.env*"
    effect: deny
```

---

## Error: Subagent Approval Gate Violation

### Symptom

```json
{
  "type": "missing-approval",
  "message": "Execution tool 'bash' called without requesting approval"
}
```

In a **subagent** test.

---

### Cause

**Subagents should NOT have approval gates** - they're delegated to by primary agents who already got approval.

The issue is usually:
1. Subagent trying to use restricted tool (bash/write/edit)
2. Test expecting approval behavior (wrong for subagents)

---

### Solution

**Fix 1: Remove Tool Usage**

Subagents shouldn't use execution tools. Update prompt to emphasize read-only nature.

**Fix 2: Update Test Configuration**

Subagent tests should use `auto-approve`:

```yaml
approvalStrategy:
  type: auto-approve  # ← No approval gates for subagents
```

**Fix 3: Check Permissions**

Ensure the subagent denies the shell action in its V2 `permissions` list (`action: shell, resource: "*", effect: deny`).

---

## Error: Tool Not Available

### Symptom

Agent tries to use a tool but framework says "tool not available".

---

### Cause

Tool not enabled in frontmatter:

```yaml
tools:
  glob: false  # ← Tool disabled
```

---

### Solution

Enable the tool:

```yaml
tools:
  glob: true  # ← Enable
```

---

## Verification Checklist

After fixing tool permission:

- [ ] Agent frontmatter has correct `tools:` configuration?
- [ ] Prompt emphasizes allowed tools in critical rules section?
- [ ] Prompt warns against restricted tools?
- [ ] Test uses `auto-approve` for subagents?
- [ ] Test verifies tool usage with `mustUseTools`?

---

## Tool Permission Matrix

| Agent Type | bash | write | edit | task | read | grep | glob | list |
|------------|------|-------|------|------|------|------|------|------|
| **Read-only subagent** | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Primary agent** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Orchestrator** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Related

- `concepts/subagent-testing-modes.md` - Understand subagent testing
- `guides/testing-subagents.md` - How to test subagents
- `examples/subagent-prompt-structure.md` - Prompt structure with tool emphasis

**Reference**: `.opencode/agent/subagents/core/contextscout.md` (tool configuration)
