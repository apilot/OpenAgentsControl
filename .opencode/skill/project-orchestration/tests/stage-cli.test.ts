/**
 * Tests for stage-cli evidence gate (machine-checkable stage outputs).
 *
 * The gate closes the self-reported completion gap on the orchestration level:
 * `complete` refuses to mark a stage completed while its path/glob outputs are
 * missing, and requires prerequisites to be completed first.
 *
 * Run: npx -y bun test .opencode/skill/project-orchestration/tests/stage-cli.test.ts
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../scripts/stage-cli.ts");

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oac-stage-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "stage-fixture" }));
  return root;
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["run", CLI, ...args], { cwd: root, encoding: "utf-8" });
}

function trackingPath(root: string, feature: string): string {
  const sessions = path.join(root, ".tmp/sessions");
  const dir = fs.readdirSync(sessions).find((d) => d.endsWith(`-${feature}`));
  if (!dir) throw new Error(`no session dir for ${feature}`);
  return path.join(sessions, dir, "stage-tracking.json");
}

function writeTracking(root: string, feature: string, opts: { completedUpTo: number; current: number }) {
  const stages = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    status: i + 1 <= opts.completedUpTo ? "completed" : i + 1 === opts.current ? "in_progress" : "pending",
    started_at: i + 1 === opts.current ? new Date().toISOString() : null,
    completed_at: i + 1 <= opts.completedUpTo ? new Date().toISOString() : null,
  }));
  fs.writeFileSync(
    trackingPath(root, feature),
    JSON.stringify({ feature, workflow_status: "in_progress", current_stage: opts.current, stages }, null, 2),
  );
}

function status(root: string, feature: string, stageId: number): string {
  const t = JSON.parse(fs.readFileSync(trackingPath(root, feature), "utf-8"));
  return t.stages.find((s: { id: number }) => s.id === stageId).status;
}

describe("stage-cli evidence gate", () => {
  it("init creates stage tracking", () => {
    const root = makeFixture();
    const proc = runCli(root, ["init", "demo"]);
    expect(proc.status).toBe(0);
    expect(fs.existsSync(trackingPath(root, "demo"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("complete refuses a stage whose artifacts are missing", () => {
    const root = makeFixture();
    expect(runCli(root, ["init", "demo"]).status).toBe(0);
    writeTracking(root, "demo", { completedUpTo: 1, current: 2 });

    const proc = runCli(root, ["complete", "demo", "2"]);
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain("Evidence gate failed");
    expect(proc.stdout).toContain("personas.json");
    expect(status(root, "demo", 2)).toBe("in_progress");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("complete passes once artifacts exist and advances the sequence", () => {
    const root = makeFixture();
    expect(runCli(root, ["init", "demo"]).status).toBe(0);
    writeTracking(root, "demo", { completedUpTo: 1, current: 2 });
    for (const f of ["personas.json", "journey-maps.md", "stories.json", "story-map.md"]) {
      fs.writeFileSync(path.join(root, f), "artifact");
    }

    const proc = runCli(root, ["complete", "demo", "2"]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Evidence gate passed (4 artifact check(s))");
    expect(status(root, "demo", 2)).toBe("completed");
    const tracking = JSON.parse(fs.readFileSync(trackingPath(root, "demo"), "utf-8"));
    expect(tracking.current_stage).toBe(3);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("complete refuses when prerequisites are not completed", () => {
    const root = makeFixture();
    expect(runCli(root, ["init", "demo"]).status).toBe(0);
    writeTracking(root, "demo", { completedUpTo: 0, current: 2 });

    const proc = runCli(root, ["complete", "demo", "2"]);
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain("prerequisites not completed");
    expect(status(root, "demo", 2)).toBe("in_progress");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("glob outputs with {feature} resolve (stage 4 task files)", () => {
    const root = makeFixture();
    expect(runCli(root, ["init", "demo"]).status).toBe(0);
    writeTracking(root, "demo", { completedUpTo: 3, current: 4 });
    const tasksDir = path.join(root, ".tmp/tasks/demo");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task.json"), "{}");
    fs.writeFileSync(path.join(tasksDir, "subtask_01.json"), "{}");

    const proc = runCli(root, ["complete", "demo", "4"]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Evidence gate passed (2 artifact check(s))");
    expect(status(root, "demo", 4)).toBe("completed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("glob outputs fail when no files match", () => {
    const root = makeFixture();
    expect(runCli(root, ["init", "demo"]).status).toBe(0);
    writeTracking(root, "demo", { completedUpTo: 3, current: 4 });
    fs.mkdirSync(path.join(root, ".tmp/tasks/demo"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tmp/tasks/demo/task.json"), "{}");
    // no subtask_*.json anywhere

    const proc = runCli(root, ["complete", "demo", "4"]);
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain("subtask_*.json");
    expect(status(root, "demo", 4)).toBe("in_progress");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prose-only outputs complete with a loud zero-check warning (stage 6)", () => {
    const root = makeFixture();
    expect(runCli(root, ["init", "demo"]).status).toBe(0);
    writeTracking(root, "demo", { completedUpTo: 5, current: 6 });

    const proc = runCli(root, ["complete", "demo", "6"]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Evidence gate: 0 machine-checkable outputs");
    expect(proc.stdout).toContain("NOT evidence-backed");
    expect(status(root, "demo", 6)).toBe("completed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects invalid feature names (path-safety)", () => {
    const root = makeFixture();
    for (const bad of ["../evil", "Foo", "has space", "a/b"]) {
      const proc = runCli(root, ["status", bad]);
      expect(proc.status).toBe(1);
      expect(proc.stdout).toContain("Invalid feature name");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("session lookup is exact-match (feature 'test' must not hit 'my-test')", () => {
    const root = makeFixture();
    // A session dir belonging to a different feature that ENDS WITH '-test'.
    const other = path.join(root, ".tmp/sessions/2026-01-01-my-test");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
      path.join(other, "stage-tracking.json"),
      JSON.stringify({ feature: "my-test", workflow_status: "in_progress", current_stage: 1, stages: [] }),
    );

    const proc = runCli(root, ["status", "test"]);
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain("No stage tracking found for feature: test");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resume refuses when prerequisites of the target stage are not completed", () => {
    const root = makeFixture();
    expect(runCli(root, ["init", "demo"]).status).toBe(0);
    // Abort the workflow, then try to resume at stage 3 while stages 1-2 are pending.
    writeTracking(root, "demo", { completedUpTo: 0, current: 3 });
    const tp = trackingPath(root, "demo");
    const t = JSON.parse(fs.readFileSync(tp, "utf-8"));
    t.workflow_status = "aborted";
    fs.writeFileSync(tp, JSON.stringify(t, null, 2));

    const proc = runCli(root, ["resume", "demo", "3"]);
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain("prerequisites not completed: 2");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
