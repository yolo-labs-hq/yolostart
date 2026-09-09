import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import worker from "../dist/worker.mjs";
const script = await readFile(
  new URL("../install.sh", import.meta.url),
  "utf8",
);
test("worker serves exact source bytes to browsers and curl", async () => {
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
});
test("piped dash preserves arguments/version/exit status without a terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yolostart-shell-test-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      join(bin, "npx"),
      '#!/bin/sh\nprintf "ARG:%s\\n" "$@"\nprintf "CACHE:%s:%s:%s:%s\\n" "$npm_config_cache" "$NPM_CONFIG_CACHE" "$npm_config_logs_dir" "$NPM_CONFIG_LOGS_DIR"\nexit 42\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      "/bin/dash",
      ["-s", "--", "--scan", "/path with spaces", "--dry-run"],
      {
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          TMPDIR: dir,
          YOLOSTART_VERSION: "0.1.0",
          NPM_CONFIG_CACHE: "/must-not-write",
          NPM_CONFIG_LOGS_DIR: "/must-not-write",
        },
      },
    );
    assert.equal(result.status, 42);
    assert.match(
      result.stdout,
      /ARG:-y\nARG:yolostart@0.1.0\nARG:--scan\nARG:\/path with spaces\nARG:--dry-run/,
    );
    assert.doesNotMatch(result.stdout, /\x1b|must-not-write/);
    assert.match(result.stdout, /CACHE:.*yolostart\./);
    await writeFile(join(bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const old = spawnSync("/bin/dash", [], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(old.status, 1);
    assert.match(old.stderr, /Node.js 20/);
    assert.doesNotMatch(old.stdout, /ARG:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
