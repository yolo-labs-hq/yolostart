import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, truncate } from "node:fs/promises";
import path from "node:path";
import { buildManifest, safeRemote } from "../src/manifest.js";
import { sensitivePath } from "../src/exclusions.js";
import { fixture, file, repo } from "./helpers.js";

test("hard exclusions cover every required secret shape at any depth", async (t) => {
  const root = await fixture(t);
  const secrets = [
    ".env",
    ".env.local",
    ".env.example",
    "cert.pem",
    "id_rsa",
    "id_rsa.pub",
    "server.key",
    "credentials.json",
    ".npmrc",
    ".netrc",
    "service-account.json",
    "service_account_key.json",
    "serviceAccount.json",
  ];
  for (const name of secrets) {
    assert.equal(sensitivePath(`nested/${name}`), true);
    await file(root, `nested/${name}`, "must not appear");
  }
  await file(root, ".aws/config");
  await file(root, ".ssh/config");
  await file(root, ".gitignore", "nested/\n");
  await file(root, "source.ts", "export {};");
  const { manifest, includePaths } = await buildManifest(root, root, false);
  for (const name of secrets)
    assert.ok(manifest.excluded.sensitive.includes(`nested/${name}`), name);
  assert.ok(manifest.excluded.sensitive.includes(".aws"));
  assert.ok(manifest.excluded.sensitive.includes(".ssh"));
  assert.deepEqual(includePaths, [".gitignore", "source.ts"]);
  assert.doesNotMatch(JSON.stringify(manifest), /must not appear/);
});
test("arbitrary service-account JSON names are detected locally, including gitignored ones", async (t) => {
  const root = await fixture(t);
  await file(
    root,
    "download-123.json",
    '{"type":"service_account","private_key":"SECRET"}',
  );
  await file(root, "ignored/unknown.json", '{"private_key": "SECRET",');
  await file(root, ".gitignore", "ignored/\n");
  await file(root, "normal.json", '{"name":"app"}');
  const { manifest, includePaths } = await buildManifest(root, root, false);
  assert.deepEqual(manifest.excluded.sensitive, [
    "download-123.json",
    "ignored/unknown.json",
  ]);
  assert.ok(includePaths.includes("normal.json"));
  assert.doesNotMatch(JSON.stringify(manifest), /SECRET/);
});
test("nested gitignore, negation and ignored parent semantics; skip builds and symlinks", async (t) => {
  const root = await fixture(t);
  await file(root, ".gitignore", "*.log\nignored/\n");
  await file(root, "src/.gitignore", "!keep.log\n");
  await file(root, "src/drop.log");
  await file(root, "src/keep.log");
  await file(root, "ignored/.gitignore", "!keep.txt\n");
  await file(root, "ignored/keep.txt");
  await file(root, "node_modules/pkg/index.js");
  await file(root, "dist/app.js");
  await file(root, "source.txt");
  await symlink("/etc/passwd", path.join(root, "external"));
  await repo(root, "nested-repo");
  await file(root, "nested-repo/never.txt");
  const { manifest, includePaths } = await buildManifest(root, root, false);
  assert.ok(includePaths.includes("src/keep.log"));
  assert.equal(manifest.excluded.gitignored, 3);
  assert.deepEqual(manifest.excluded.skipped, [
    "dist",
    "external",
    "nested-repo",
    "node_modules",
  ]);
  assert.ok(!includePaths.includes("src/drop.log"));
  assert.ok(!includePaths.includes("ignored/keep.txt"));
});
test("oversize and bounded tree summary report accurate counts and bytes", async (t) => {
  const root = await fixture(t);
  await file(root, "large.bin");
  await truncate(path.join(root, "large.bin"), 25 * 1024 * 1024 + 1);
  for (let i = 0; i < 205; i++)
    await file(root, `folder${i}/deep/file.txt`, "1234");
  const { manifest, includePaths } = await buildManifest(root, root, false);
  assert.deepEqual(manifest.excluded.oversize, ["large.bin"]);
  assert.equal(manifest.fileCount, 205);
  assert.equal(manifest.bytes, 820);
  assert.equal(includePaths.length, 205);
  assert.equal(manifest.tree.length, 200);
  assert.equal(
    manifest.tree.reduce((n, item) => n + item.fileCount, 0),
    205,
  );
  assert.equal(
    manifest.tree.reduce((n, item) => n + item.bytes, 0),
    820,
  );
  assert.ok(manifest.tree.every((item) => item.path.split("/").length <= 2));
});
test("remote metadata strips credentials, query strings and local paths", () => {
  assert.equal(
    safeRemote(
      "https://user:SECRET@github.com/owner/repo.git?token=SECRET#SECRET",
    ),
    "https://github.com/owner/repo.git",
  );
  assert.equal(
    safeRemote("git@github.com:owner/repo.git"),
    "git@github.com:owner/repo.git",
  );
  assert.equal(safeRemote("/private/local/repo"), null);
});

test("escaped JSON keys and values cannot hide service-account credentials", async (t) => {
  const root = await fixture(t);
  await file(root, "download.json", '{"\\u0074ype":"service\\u005faccount"}');
  const result = await buildManifest(root, root, false);
  assert.deepEqual(result.manifest.excluded.sensitive, ["download.json"]);
  assert.deepEqual(result.includePaths, []);
});
