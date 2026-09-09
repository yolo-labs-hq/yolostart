import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import worker from "../dist/worker.mjs";
const script = await readFile(
  new URL("../install.sh", import.meta.url),
  "utf8",
);
test("browser and curl receive exact POSIX source; release assets use the native distribution", async () => {
  for (const agent of ["curl/8", "Mozilla/5.0"]) {
    const response = worker.fetch(
      new Request("https://example.test/", {
        headers: { "User-Agent": agent },
      }),
    );
    assert.equal(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.equal(await response.text(), script);
  }
  assert.match(script, /^[\x00-\x7f]*$/);
  const response = worker.fetch(
    new Request("https://example.test/releases/latest.txt"),
    { ASSETS: { fetch: () => new Response("0.2.0\n") } },
  );
  assert.equal(await response.text(), "0.2.0\n");
  assert.equal(
    worker.fetch(new Request("https://example.test/missing")).status,
    404,
  );
});
test("piped shell uses no Node/npm, preserves pins/arguments/exit status and fails on corruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yolostart-shell-test-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    for (const name of ["cat", "mktemp", "sha256sum", "gzip", "awk", "chmod"])
      await symlink(`/usr/bin/${name}`, join(bin, name));
    await writeFile(
      join(bin, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
      { mode: 0o755 },
    );
    const raw = Buffer.from('#!/bin/sh\nprintf "ARG:%s\\n" "$@"\nexit 42\n');
    const compressed = gzipSync(raw);
    await writeFile(join(dir, "binary.gz"), compressed);
    const hash = createHash("sha256").update(compressed).digest("hex");
    await writeFile(
      join(dir, "SHA256SUMS"),
      `${hash}  yolostart-linux-amd64.gz\n`,
    );
    await writeFile(join(dir, "latest.txt"), "0.2.0\n");
    await writeFile(
      join(bin, "curl"),
      '#!/bin/sh\nfor arg do\n case "$arg" in https:*) url=$arg;; esac\n dest=$arg\ndone\nprintf "%s\\n" "$url" >> "$FIXTURE_DIR/requests"\ncase "$url" in */latest.txt) /bin/cp "$FIXTURE_DIR/latest.txt" "$dest";; */0.2.0/SHA256SUMS) /bin/cp "$FIXTURE_DIR/SHA256SUMS" "$dest";; */0.2.0/yolostart-linux-amd64.gz) /bin/cp "$FIXTURE_DIR/binary.gz" "$dest";; *) exit 22;; esac\n',
      { mode: 0o755 },
    );
    const run = (version) =>
      spawnSync("/bin/dash", ["-s", "--", "--scan", "/a path", "--dry-run"], {
        input: script,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          PATH: bin,
          TMPDIR: dir,
          FIXTURE_DIR: dir,
          YOLOSTART_VERSION: version,
        },
      });
    let result = run("0.2.0");
    assert.equal(result.status, 42, result.stderr);
    assert.match(result.stdout, /ARG:--scan\nARG:\/a path\nARG:--dry-run/);
    assert.doesNotMatch(result.stdout, /\x1b/);
    assert.doesNotMatch(
      await readFile(join(dir, "requests"), "utf8"),
      /latest.txt/,
    );
    result = run("latest");
    assert.equal(result.status, 42, result.stderr);
    assert.match(await readFile(join(dir, "requests"), "utf8"), /latest.txt/);
    await writeFile(join(dir, "binary.gz"), "corrupt");
    result = run("0.2.0");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Checksum mismatch/);
    assert.doesNotMatch(result.stdout, /ARG:/);
    await writeFile(join(dir, "SHA256SUMS"), "");
    assert.match(run("0.2.0").stderr, /invalid release checksum/);
    assert.match(run("../escape").stderr, /Invalid YOLOSTART_VERSION/);
    assert.match(run("9.9.9").stderr, /Download failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
