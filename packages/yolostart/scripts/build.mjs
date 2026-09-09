import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Build failed: ${command}: ${result.error?.message ?? result.status}`,
    );
}
// Never leave the retired TypeScript scanner in a published dist directory.
for (const file of await readdir(path.join(root, "dist")).catch(() => [])) {
  if (file.endsWith(".js")) await rm(path.join(root, "dist", file));
}
run(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "-p",
  "tsconfig.json",
]);
const hash = createHash("sha256");
hash.update(await readFile(new URL(import.meta.url)));
hash.update(version);
async function hashSource(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await hashSource(p);
    else {
      hash.update(path.relative(root, p));
      hash.update(await readFile(p));
    }
  }
}
await hashSource(path.join(root, "native"));
const sourceDigest = hash.digest("hex");
const output = path.join(root, "dist", "native", version);
const digest = (data) => createHash("sha256").update(data).digest("hex");
const previous = await readFile(path.join(output, "manifest.json"), "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (
  previous?.sourceDigest === sourceDigest &&
  (
    await Promise.all(
      Object.values(previous.files).map(async (entry) => {
        try {
          return (
            digest(await readFile(path.join(output, entry.file))) ===
            entry.sha256
          );
        } catch {
          return false;
        }
      }),
    )
  ).every(Boolean)
) {
  console.log(`Native ${version}: using verified build artifacts.`);
} else {
  await mkdir(output, { recursive: true });
  const manifest = { version, sourceDigest, files: {} };
  for (const os of ["linux", "darwin"])
    for (const arch of ["amd64", "arm64"]) {
      const platform = `${os}-${arch}`;
      const binary = path.join(output, `yolostart-${platform}`);
      console.log(`Building native ${platform}...`);
      run(
        process.env.GO_BINARY || "go",
        [
          "build",
          "-trimpath",
          "-buildvcs=false",
          "-ldflags",
          `-s -w -buildid= -X github.com/yolo-labs-hq/yolostart.Version=${version}`,
          "-o",
          binary,
          "./cmd/yolostart",
        ],
        {
          cwd: path.join(root, "native"),
          env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
        },
      );
      const raw = await readFile(binary);
      const compressed = gzipSync(raw, { level: 9 });
      const file = `yolostart-${platform}.gz`;
      await writeFile(path.join(output, file), compressed);
      manifest.files[platform] = {
        file,
        sha256: digest(compressed),
        executableSha256: digest(raw),
      };
      await rm(binary);
    }
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(
    path.join(output, "SHA256SUMS"),
    Object.values(manifest.files)
      .map((entry) => `${entry.sha256}  ${entry.file}\n`)
      .join(""),
  );
}
await writeFile(
  path.join(root, "dist", "native", "latest.txt"),
  version + "\n",
);

await writeFile(
  path.join(output, "THIRD_PARTY_NOTICES.txt"),
  await readFile(path.join(root, "THIRD_PARTY_NOTICES.txt")),
);
