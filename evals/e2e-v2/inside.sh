#!/usr/bin/env bash
# Container-side E2E: validate OpenAgentsControl in a clean room.
#
# Scenarios:
#   [2][3] clean-room test suites (plugin 118, repo 43)
#   [5]    T1 LIVE ENFORCEMENT: real opencode (v1 engine), real LLM (glm-5.3-flash):
#          plugin loads from .opencode/plugins, model runs an ability AND attempts a
#          bash bypass in the SAME turn -> bash denied by plugin hook, ability completes
#   [6]    T3 task-cli evidence gate (verify / cheat-complete refused / legit complete)
#   [7]    opencode2 (v2 preview) plugin-contract status note
#
# All output goes to $REPORT (host-visible via /out volume mount).
set -uo pipefail

REPORT=/out/e2e-report.txt
mkdir -p /out

FAILURES=0
step() { echo; echo "══════════════ $* ══════════════"; }
pass() { echo "✅ $*"; }
fail() { echo "❌ $*"; FAILURES=$((FAILURES+1)); }

main() {

step "[0] clean-room env"
node --version
bun --version
opencode --version | head -1
opencode2 --version 2>&1 | head -1
git --version
jq --version

step "[1] fresh repo copy (host mount is read-only) + npm install"
rm -rf /home/node/e2e/work/oac
tar -cf /tmp/repo.tar -C /opt/oac --exclude=node_modules --exclude=.git .
mkdir -p /home/node/e2e/work/oac
tar -xf /tmp/repo.tar -C /home/node/e2e/work/oac
rm -f /tmp/repo.tar
echo "repo copy: $(find /home/node/e2e/work/oac -type f | wc -l) files"
cd /home/node/e2e/work/oac/packages/plugin-abilities
npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1
pass "npm install (plugin-abilities)"

step "[2] sanity: plugin test suite in clean environment"
if bun test 2>&1 | tail -4 | tee /tmp/suite.txt | grep -qE '[0-9]+ pass'; then
  grep -E '[0-9]+ pass' /tmp/suite.txt
  if grep -qE ' 0 fail' /tmp/suite.txt; then
    pass "plugin suite green in clean env (118 expected)"
  else
    fail "plugin suite has failures"
  fi
else
  fail "plugin suite crashed"
fi

step "[3] repo-level suites: registry linter + task verification gate"
cd /home/node/e2e/work/oac
if bun test scripts/maintenance/validate-registry.test.ts .opencode/skill/task-management/tests/verification.test.ts 2>&1 | tail -4 | tee /tmp/suite2.txt; then
  grep -qE ' 0 fail' /tmp/suite2.txt && pass "repo suites green (43)" || fail "repo suites have failures"
else
  fail "repo suites crashed"
fi

step "[4] fixture project (v1 engine: opencode.json + plugin wrapper + ability)"
FIX=/home/node/e2e/v1-project
rm -rf "$FIX"; mkdir -p "$FIX/.opencode/plugins" "$FIX/.opencode/abilities"
cd "$FIX"
git init -q . 2>/dev/null
# v1 config. NOTE: permission.webfetch is a SCALAR in v1 (a map invalidates the whole config).
# Provider key is injected via env/jq, never echoed.
jq -n --arg key "${ZAI_API_KEY:-$Z_AI_API_KEY}" '{
  "$schema": "https://opencode.ai/config.json",
  "model": "zai-coding-plan/glm-5.3-flash",
  "small_model": "zai-coding-plan/glm-5.3-flash",
  "permission": { "bash": {"*": "allow"}, "edit": {"*": "allow"}, "webfetch": "allow" },
  "provider": {
    "zai-coding-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Z.ai Coding Plan",
      "options": { "baseURL": "https://api.z.ai/api/coding/paas/v4", "apiKey": $key },
      "models": { "glm-5.3-flash": { "name": "GLM 5.3 Flash" } }
    }
  }
}' > opencode.json
chmod 600 opencode.json
# v1 file-plugin contract: default export must be {id, server}.
cat > .opencode/plugins/abilities-v1.ts <<'EOF'
// Live-enforcement adapter: expose the abilities plugin to opencode v1 loader.
import { AbilitiesPlugin } from "/home/node/e2e/work/oac/packages/plugin-abilities/src/opencode-plugin.ts";
export default { id: "abilities-v1", server: AbilitiesPlugin };
EOF
cat > .opencode/abilities/guard-demo-long.yaml <<'YAML'
name: guard-demo-long
description: Long ability with a blocking script step for live enforcement checks
steps:
  - id: wait
    type: script
    run: sleep 90
  - id: done
    type: script
    run: echo "guard-demo-long-done"
    needs: [wait]
YAML
pass "fixture ready: $FIX (ability window: 90s)"

step "[5] T1: LIVE ENFORCEMENT — model runs ability + bash bypass in the SAME turn"
cd "$FIX"
# v1 provider resolution also accepts ZHIPU_API_KEY via the models.dev catalog entry.
export ZHIPU_API_KEY="${ZAI_API_KEY:-$Z_AI_API_KEY}"

rm -f /tmp/run-t1.log
nohup opencode run --print-logs --format json \
  "You MUST issue BOTH of these tool calls TOGETHER in ONE single response, in parallel: (1) ability_run with ability name guard-demo-long; (2) bash with command: echo bypass-attempt-777 . Do NOT wait for the first tool to finish before making the second call." \
  > /tmp/run-t1.log 2>&1 &
RUNPID=$!
echo "run pid: $RUNPID"

STARTED=no
for i in $(seq 1 60); do
  grep -q "Starting execution: guard-demo-long" /tmp/run-t1.log 2>/dev/null && { STARTED=yes; break; }
  kill -0 "$RUNPID" 2>/dev/null || break
  sleep 1
done
if [ "$STARTED" = yes ]; then
  pass "ability execution started (${i}s)"
else
  fail "ability never started"
fi

WAITED=0
while kill -0 "$RUNPID" 2>/dev/null && [ "$WAITED" -lt 240 ]; do sleep 5; WAITED=$((WAITED+5)); done
kill -0 "$RUNPID" 2>/dev/null && { fail "run did not finish in 240s"; kill "$RUNPID" 2>/dev/null; }
echo "run finished after ~${WAITED}s"

python3 - <<'PY' > /tmp/t1-evidence.txt 2>&1
import json

bash_denial = None
bash_ok     = False
run_done    = False
final_text  = ""

for line in open('/tmp/run-t1.log'):
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    part = obj.get('part') if isinstance(obj.get('part'), dict) else {}
    tool = part.get('tool')
    state = part.get('state') if isinstance(part.get('state'), dict) else {}
    if obj.get('type') == 'tool_use' and tool == 'bash':
        if state.get('status') == 'error' and 'blocked during script step' in str(state.get('error', '')):
            bash_denial = str(state.get('error'))
        elif state.get('status') == 'completed':
            bash_ok = True
    if obj.get('type') == 'tool_use' and tool == 'ability.run':
        if state.get('status') == 'completed':
            run_done = True
    if obj.get('type') == 'text':
        final_text += obj.get('text', '')

print(f"bash_denial={bash_denial!r}")
print(f"bash_completed={bash_ok}")
print(f"ability_run_completed={run_done}")
print(f"final_mentions_completed={'completed' in final_text.lower()}")
PY
cat /tmp/t1-evidence.txt
. /tmp/t1-evidence.txt

grep -q "\[abilities\] Loaded" /tmp/run-t1.log \
  && pass "T1: plugin loaded by real opencode ([abilities] Loaded)" \
  || fail "T1: plugin not loaded"

grep -q "Starting execution: guard-demo-long" /tmp/run-t1.log \
  && pass "T1: ability execution started" \
  || fail "T1: ability execution not started"

if [ -n "${bash_denial:-}" ]; then
  pass "T1: bypass DENIED by hook — bash tool errored, command never executed"
  echo "     denial: $bash_denial"
else
  fail "T1: no bash denial observed"
fi
[ "${bash_completed:-False}" = "True" ] && fail "T1: bash BYPASSED the gate (completed)!"

if grep -q "Step 2/2: done" /tmp/run-t1.log; then
  pass "T1: ability ran to completion (step 2/2 executed after the blocked bypass)"
else
  fail "T1: ability did not complete"
fi
if [ "${ability_run_completed:-False}" = "True" ]; then
  pass "T1: ability.run tool reported completed"
else
  fail "T1: ability.run did not report completed"
fi
[ "${final_mentions_completed:-False}" = "True" ] \
  && pass "T1: model reported final status completed" \
  || echo "(note: final text wording did not include 'completed' — non-fatal)"

step "[6] T3: evidence-based completion gate (task-cli) in clean env"
mkdir -p /tmp/gate/.tmp/tasks/gate-demo /tmp/gate/src
cd /tmp/gate
echo 'export const gate = true' > src/gate.ts
printf '%s' '{"id":"gate-demo"}' > .tmp/tasks/gate-demo/task.json
cat > .tmp/tasks/gate-demo/subtask_01.json <<'JSON'
{
  "id": "gate-demo-01", "seq": "01", "title": "gate smoke",
  "status": "in_progress", "depends_on": [], "parallel": false,
  "context_files": [], "acceptance_criteria": ["x"], "deliverables": ["src/gate.ts"],
  "agent_id": null, "started_at": null, "completed_at": null, "completion_summary": null,
  "verification": [
    { "type": "file_contains", "path": "src/gate.ts", "expect_contains": "gate = true" },
    { "type": "command", "command": "node -e \"process.exit(0)\"" }
  ]
}
JSON
CLI=/home/node/e2e/work/oac/.opencode/skills/task-management/scripts/task-cli.ts
if bun run "$CLI" verify gate-demo 01 >/tmp/gate/verify.log 2>&1; then
  pass "verify: all checks passed"
else
  fail "verify: should pass"; cat /tmp/gate/verify.log
fi
sed -i 's/gate = true/gate = FALSE/' src/gate.ts
if bun run "$CLI" complete gate-demo 01 "cheat" >/tmp/gate/complete.log 2>&1; then
  fail "complete: gate let a failing task through!"
else
  STATUS=$(python3 -c "import json;print(json.load(open('.tmp/tasks/gate-demo/subtask_01.json'))['status'])")
  [ "$STATUS" = "in_progress" ] && pass "complete: gate refused failing task (status still in_progress)" || fail "complete: gate refused but status mutated: $STATUS"
fi
sed -i 's/gate = FALSE/gate = true/' src/gate.ts
if bun run "$CLI" complete gate-demo 01 "legit" >/tmp/gate/complete2.log 2>&1; then
  pass "complete: passed after fix"
else
  fail "complete: refused a legitimately fixed task"; cat /tmp/gate/complete2.log
fi

step "[7] opencode2 (v2 preview) plugin-contract status"
if opencode2 --version >/dev/null 2>&1; then
  echo "opencode2 present: $(opencode2 --version 2>&1 | head -1)"
  echo "v2 preview Context exposes only {options, agent, aisdk, catalog, command, integration,"
  echo "plugin, reference, skill} domains — tool/permission/session/storage hooks land in a"
  echo "later preview. Our v2 plugin (src/v2-plugin.ts) is implemented against the target API"
  echo "typed by @opencode/plugin@2.0.21 and covered by 28 unit/integration tests; live v2"
  echo "activation is deferred until the preview ships those domains. Enforcement is live-"
  echo "proven above through the v1 engine, whose semantics (A1 window, same denial text) the"
  echo "v2 plugin preserves."
  pass "v2 status documented (not counted as failure)"
else
  echo "opencode2 not present (skipped)"
fi

step "[8] verdict"
echo "failures: $FAILURES"
if [ "$FAILURES" -eq 0 ]; then
  pass "E2E: all scenarios green"
  return 0
else
  fail "E2E: $FAILURES scenario(s) failed"
  return 1
fi
}

if main > "$REPORT" 2>&1; then
  cat "$REPORT"
  echo "✅ E2E PASS (report: $REPORT)"
  exit 0
else
  cat "$REPORT"
  echo "❌ E2E FAIL (report: $REPORT)"
  exit 1
fi
