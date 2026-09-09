import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing/old Node or missing npx downloads into temp; checksum failure never executes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yolostart-runtime-test-'));
  try {
    const bin = join(dir, 'bin');
    const runtime = 'node-v24.21.0-linux-x64';
    const runtimeBin = join(dir, 'fixture', runtime, 'bin');
    await mkdir(bin); await mkdir(runtimeBin, { recursive: true });
    for (const cmd of ['cat', 'mktemp', 'sha256sum', 'tar', 'gzip']) await symlink(`/usr/bin/${cmd}`, join(bin, cmd));
    await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
    await writeFile(join(runtimeBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(runtimeBin, 'npx'), '#!/bin/sh\nprintf "TEMP-NPX:%s\\n" "$@"\n', { mode: 0o755 });
    const archive = join(dir, 'fixture.tar.gz');
    assert.equal(spawnSync('/usr/bin/tar', ['-czf', archive, '-C', join(dir, 'fixture'), runtime]).status, 0);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(join(bin, 'curl'), '#!/bin/sh\nfor arg do dest=$arg; done\n/bin/cp "$FIXTURE_ARCHIVE" "$dest"\n', { mode: 0o755 });
    const fixtureScript = script.replace('6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff', digest);
    const run = (input) => spawnSync('/bin/dash', ['-s', '--', '--scan', '/a path', '--dry-run'], {
      input, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: bin, TMPDIR: dir, FIXTURE_ARCHIVE: archive, YOLOSTART_VERSION: '0.1.0' },
    });
    for (const node of [null, '#!/bin/sh\nexit 1\n', '#!/bin/sh\nexit 0\n']) {
      if (node) await writeFile(join(bin, 'node'), node, { mode: 0o755 });
      const result = run(fixtureScript);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /TEMP-NPX:yolostart@0.1.0\nTEMP-NPX:--scan\nTEMP-NPX:\/a path\nTEMP-NPX:--dry-run/);
      assert.match(result.stderr, /temporary Node runtime/);
    }
    const invalid = run(script);
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /checksum mismatch/);
    assert.doesNotMatch(invalid.stdout, /TEMP-NPX/);
    await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
    assert.match(run(fixtureScript).stderr, /download failed/);
    await writeFile(join(bin, 'uname'), '#!/bin/sh\necho unsupported\n', { mode: 0o755 });
    assert.match(run(fixtureScript).stderr, /Install Node 20/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
