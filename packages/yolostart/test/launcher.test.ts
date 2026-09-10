import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { launch } from "../src/launcher.js";
const dist = new URL("../dist/", import.meta.url);
const native = new URL("native/0.3.4/", dist);

test("npm wrapper runs the same native executable and forwards help/version", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", native), "utf8"),
  );
  assert.equal(manifest.version, "0.3.4");
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    "darwin-amd64",
    "darwin-arm64",
    "linux-amd64",
    "linux-arm64",
  ]);
  for (const entry of Object.values(manifest.files) as {
    file: string;
    sha256: string;
    executableSha256: string;
  }[]) {
    const compressed = await readFile(new URL(entry.file, native));
    assert.equal(
      createHash("sha256").update(compressed).digest("hex"),
      entry.sha256,
    );
    assert.equal(
      createHash("sha256").update(gunzipSync(compressed)).digest("hex"),
      entry.executableSha256,
    );
  }
  for (const [args, expected] of [
    [["--version"], /0\.3\.4/],
    [["--help"], /Usage: yolostart/],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("cli.js", dist)), ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, expected);
  }
});
test("wrapper forwards arguments and exit status, and refuses corrupt artifacts", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yolostart-wrapper-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = pathToFileURL(dir + "/");
  const raw = Buffer.from(
    '#!/bin/sh\n[ "$1" = "--scan" ] && [ "$2" = "/a path" ] || exit 99\nexit 42\n',
  );
  const compressed = gzipSync(raw);
  const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const name = "yolostart-linux-amd64.gz";
  await writeFile(new URL(name, url), compressed);
  await writeFile(
    new URL("manifest.json", url),
    JSON.stringify({
      files: {
        "linux-amd64": {
          file: name,
          sha256: digest(compressed),
          executableSha256: digest(raw),
        },
      },
    }),
  );
  assert.equal(await launch(["--scan", "/a path"], url, "linux", "x64"), 42);
  await writeFile(new URL(name, url), "corrupt");
  await assert.rejects(launch([], url, "linux", "x64"), /checksum mismatch/);
  await assert.rejects(
    launch([], url, "win32", "x64"),
    /supports macOS\/Linux/,
  );
});
test("built wrapper has no interactive or network APIs and no retired TS scanner", async () => {
  const files = (await readdir(dist))
    .filter((name) => name.endsWith(".js"))
    .sort();
  assert.deepEqual(files, ["cli.js", "launcher.js"]);
  for (const name of files)
    assert.doesNotMatch(
      await readFile(new URL(name, dist), "utf8"),
      /readline|createInterface|\/dev\/tty|\b(?:inquirer|enquirer|prompts)\b|\bprompt\s*\(|process\.stdin|setRawMode|isTTY|\bfetch\s*\(|node:https?/,
    );
});
