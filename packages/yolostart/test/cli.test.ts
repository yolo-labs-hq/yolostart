import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fixture, file, repo } from "./helpers.js";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("built package contains zero interactive APIs and no emitted tests", async () => {
  const names = await readdir(dist);
  for (const name of names) {
    assert.doesNotMatch(name, /\.test\./);
    const source = await readFile(path.join(dist, name), "utf8");
    assert.doesNotMatch(
      source,
      /readline|createInterface|\/dev\/tty|\b(?:inquirer|enquirer|prompts)\b|\bprompt\s*\(|process\.stdin|setRawMode|isTTY/,
    );
  }
});
test("built CLI dry-run with closed stdin: only auth network, multi-repo and plain manifests", async (t) => {
  const base = await fixture(t);
  const hook = path.join(base, "auth-fixture.mjs");
  await writeFile(
    hook,
    `
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push(url);
  if (url === 'https://auth.yololabs.ai/api/v1/auth/device/code') return Response.json({ device_code: 'test-device', user_code: 'ABCD-2345', verification_uri: 'https://yolo.studio/device', expires_in: 600, interval: 5 });
  if (url === 'https://auth.yololabs.ai/api/v1/auth/device/token') return Response.json({ access_token: 'TEST-PRIVATE-TOKEN' });
  throw new Error('Unexpected network: ' + url);
};
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 5000 ? 0 : ms, ...args);
process.on('exit', () => { if (calls.length !== 2) process.exitCode = 99; });
`,
  );
  const plain = path.join(base, "plain");
  await file(plain, "app.txt");
  const multi = path.join(base, "multi");
  await repo(multi, "one");
  await repo(multi, "two");
  for (const [root, mode, count] of [
    [plain, "plain", 1],
    [multi, "picker", 2],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        hook,
        path.join(dist, "cli.js"),
        "--scan",
        root,
        "--dry-run",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.mode, mode);
    assert.equal(manifest.candidates.length, count);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /TEST-PRIVATE-TOKEN|test-device/,
    );
  }
});
test("help and unavailable import exit before auth", () => {
  const result = spawnSync(process.execPath, [path.join(dist, "cli.js")], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not yet available/);
  assert.doesNotMatch(result.stderr, /Sign in:/);
  const help = spawnSync(
    process.execPath,
    [path.join(dist, "cli.js"), "--help"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});
