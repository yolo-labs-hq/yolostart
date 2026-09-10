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
test("User-Agent never selects HTML; release assets keep the native distribution", async () => {
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
  const response = await worker.fetch(
    new Request("https://example.test/releases/latest.txt"),
    { ASSETS: { fetch: () => new Response("0.2.0\n") } },
  );
  assert.equal(await response.text(), "0.2.0\n");
  assert.equal(
    worker.fetch(new Request("https://example.test/missing")).status,
    404,
  );
});
test('document navigation and HTML Accept select the landing page with cache isolation', async () => {
  const banner = script.match(/cat <<'BANNER'\n([\s\S]*?)\nBANNER\n/)[1];
  const escaped = banner.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  for (const headers of [
    {'Sec-Fetch-Dest': 'document'},
    {Accept: 'text/html'},
    {Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'curl/8'},
    {'Sec-Fetch-Dest': 'document', Accept: '*/*'},
  ]) {
    const response = worker.fetch(new Request('https://example.test/', {headers}));
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('vary'), 'Accept, Sec-Fetch-Dest');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /curl -fsSL https:\/\/yolostart.sh \| sh/);
    assert.match(html, /href="\/install.sh"/);
    assert.match(html, /npx yolostart<\/code> — coming soon/);
    assert.ok(html.includes(escaped), 'banner comes from the installer verbatim');
    assert.equal((html.match(/<script\b/gi) ?? []).length, 1);
    assert.match(html, /<script>[\s\S]*<\/script>\s*<\/body>/);
    assert.doesNotMatch(html, /<script[^>]+src\s*=|<link[^>]+rel="stylesheet"|<img\b|\bsrc\s*=|@import|url\(/i);
    assert.match(html, /<button[^>]+id="copy-command"[^>]+hidden>Copy<\/button>/);
  }
});

test('raw routes and curl-shaped requests always receive identical script bytes', async () => {
  const browserHeaders = {'Sec-Fetch-Dest': 'document', Accept: 'text/html'};
  for (const [path, headers] of [
    ['/', {}], ['/', {Accept: '*/*'}], ['/', {'Sec-Fetch-Dest': 'empty'}],
    ['/install.sh', browserHeaders], ['/install.sh?version=0.2.0', browserHeaders],
    ['/?raw', browserHeaders], ['/?raw=1', browserHeaders],
    ['/?version=0.2.0', {}],
  ]) {
    const response = worker.fetch(new Request('https://example.test' + path, {headers}));
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('vary'), 'Accept, Sec-Fetch-Dest');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(script));
  }
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

test('npx package alias maps to the versioned tarball without stale caching', async () => {
  let target;
  const response = await worker.fetch(new Request('https://example.test/yolostart.tgz'), {ASSETS:{fetch(request){target=new URL(request.url).pathname;return new Response('package');}}});
  const { version } = JSON.parse(await readFile(new URL('../../packages/yolostart/package.json', import.meta.url), 'utf8'));
  assert.equal(target, `/releases/${version}/yolostart-${version}.tgz`);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(await response.text(),'package');
});

test('release inventory is never served from a stale browser cache',async()=>{
 const response=await worker.fetch(new Request('https://example.test/releases/index.json'),{ASSETS:{fetch:()=>Response.json({schemaVersion:1,releases:[]})}});
 assert.equal(response.headers.get('cache-control'),'no-store');
});
