import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveProjects, selectProject } from "../src/resolve.js";
import { scan } from "../src/scan.js";
import { fixture, file, repo } from "./helpers.js";

test("ladder 1 and 2: repo root wins over children, and subdirectories resolve upward", async (t) => {
  const base = await fixture(t);
  const root = await repo(base, "primary");
  await repo(root, "nested");
  await mkdir(path.join(root, "src"));
  for (const start of [root, path.join(root, "src")]) {
    const result = await resolveProjects(start);
    assert.equal(result.mode, "single");
    assert.deepEqual(
      result.candidates.map((c) => c.root),
      [root],
    );
  }
});
test("ladder 3: children through depth two only; ignore dependencies, ignored dirs and symlinks", async (t) => {
  const base = await fixture(t);
  const root = await repo(base, "group/primary");
  await repo(base, "a/b/too-deep");
  await repo(base, "node_modules/dependency");
  await repo(base, "ignored");
  await file(base, ".gitignore", "ignored/\n");
  await symlink(root, path.join(base, "linked"));
  const result = await resolveProjects(base);
  assert.equal(result.mode, "single");
  assert.deepEqual(
    result.candidates.map((c) => c.root),
    [root],
  );
});
test("ladder 4: all repos ranked by commit recency, then mtime, with no implicit choice", async (t) => {
  const base = await fixture(t);
  const old = await repo(base, "old", "2025-01-01T00:00:00Z");
  const newer = await repo(base, "newer", "2026-01-01T00:00:00Z");
  const newest = await repo(base, "newest", "2026-01-01T00:00:00Z");
  await utimes(old, 500, 500);
  await utimes(newer, 100, 100);
  await utimes(newest, 200, 200);
  const result = await resolveProjects(base);
  assert.equal(result.mode, "picker");
  assert.equal(selectProject(result), undefined);
  assert.deepEqual(
    result.candidates.map((c) => c.name),
    ["newest", "newer", "old"],
  );
  const output = await scan(base);
  assert.equal(output.mode, "picker");
  assert.equal(output.candidates.length, 3);
  assert.deepEqual(
    output.candidates.map((c) => c.name),
    ["newest", "newer", "old"],
  );
});
test("ladder 5: no repo emits a plain adopt-dir candidate without input", async (t) => {
  const base = await fixture(t);
  await file(base, "hello.txt");
  assert.equal((await resolveProjects(base)).mode, "plain");
  const result = await scan(base);
  assert.equal(result.mode, "plain");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, "adopt-dir");
  assert.equal(result.candidates[0].git, null);
  assert.equal(result.candidates[0].fileCount, 1);
});
test("explicit project is unique; only selected files enter the manifest and others remain names", async (t) => {
  const base = await fixture(t);
  await repo(base, "a/same");
  await repo(base, "b/same");
  await file(base, "a/same/picked.txt");
  await file(base, "b/same/private-loser.txt");
  const result = await resolveProjects(base);
  assert.throws(() => selectProject(result, "same"), /uniquely/);
  assert.throws(() => selectProject(result, "missing"), /uniquely/);
  assert.equal(
    selectProject(result, "a/same")?.root,
    path.join(base, "a/same"),
  );
  const output = await scan(base, "a/same");
  assert.equal(output.mode, "single");
  assert.equal(output.candidates.length, 1);
  assert.deepEqual(output.otherRepos, ["same"]);
  assert.doesNotMatch(JSON.stringify(output), /private-loser/);
});
test("git worktree pointer resolves correctly without following it into external history", async (t) => {
  const base = await fixture(t);
  const root = await repo(base, "repo", "2026-01-01T00:00:00Z");
  const worktree = path.join(base, "lane");
  execFileSync("git", [
    "-C",
    root,
    "worktree",
    "add",
    "-q",
    "-b",
    "lane",
    worktree,
  ]);
  const result = await scan(worktree);
  assert.equal(result.mode, "single");
  assert.equal(result.candidates[0].git?.branch, "lane");
  assert.ok(result.candidates[0].excluded.skipped.includes(".git"));
});
