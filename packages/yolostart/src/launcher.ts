import { mkdir, mkdtemp, open, lstat, rename, rm, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { RELEASE_BASE, trustedReleaseRedirect } from "./release-url.mjs";

const LIMIT = 64 * 1024 * 1024;
const FALLBACK = "Try: curl -fsSL https://yolostart.sh | sh";
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
type Entry = { file: string; sha256: string; executableSha256: string };
export type Release = { version: string; files: Record<string, Entry> };
// Build replaces this sentinel with digests verified against all four native artifacts.
const PINNED_RELEASE: Release | undefined = undefined;
export type LaunchOptions = {
  pinnedRelease?: Release;
  platform?: string; arch?: string; env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};
async function download(url: string, limit: number, fetchImpl: typeof fetch): Promise<Buffer> {
  const signal = AbortSignal.timeout(120_000);
  const options = { redirect: "manual" as const, signal, headers: { "User-Agent": "yolostart-bootstrap/1 (+https://yolo.studio)" } };
  let response = await fetchImpl(url, options);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || !trustedReleaseRedirect(url, location)) throw Error("Untrusted release redirect.");
    response = await fetchImpl(new URL(location, url).href, options);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error(`Release download failed (HTTP ${response.status}).`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw Error("Release download exceeds size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
async function cached(file: string): Promise<Buffer | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > LIMIT) return;
      // Bound reads even if a concurrent writer grows the file after stat.
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        length += chunk.length;
        if (length > LIMIT) return;
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally { await handle.close(); }
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}
function unpack(compressed: Buffer, entry: Entry): Buffer {
  if (digest(compressed) !== entry.sha256) throw Error("Compressed executable checksum mismatch.");
  const binary = gunzipSync(compressed, { maxOutputLength: LIMIT });
  if (digest(binary) !== entry.executableSha256) throw Error("Unpacked executable checksum mismatch.");
  return binary;
}
async function atomicWrite(dir: string, filename: string, data: Buffer, mode: number) {
  const temp = await mkdtemp(path.join(dir, ".download-"));
  try {
    const file = path.join(temp, "verified");
    const handle = await open(file, "wx", mode);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await chmod(file, mode);
    await rename(file, path.join(dir, filename));
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export async function resolveExecutable(options: LaunchOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const pinned = options.pinnedRelease ?? PINNED_RELEASE;
  const override = env.YOLOSTART_VERSION !== undefined;
  let mode = override ? `override ${JSON.stringify(env.YOLOSTART_VERSION)} (fetched manifest)`
    : `pinned ${pinned?.version ?? "unbuilt"} (embedded digests)`;
  try {
    const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
    const cpu = arch === "x64" ? "amd64" : arch;
    if (!["linux", "darwin"].includes(platform) || !["amd64", "arm64"].includes(cpu))
      throw Error("yolostart supports macOS/Linux on x64/arm64.");
    const fetchImpl = options.fetchImpl ?? fetch;
    let version = override ? env.YOLOSTART_VERSION! : pinned?.version ?? "";
    if (version === "latest") version = (await download(RELEASE_BASE + "latest.txt", 128, fetchImpl)).toString().trim();
    if (!versionPattern.test(version)) throw Error("Invalid YOLOSTART_VERSION or latest release version.");
    if (override) mode += ` [resolved ${version}]`;
    const target = `${platform}-${cpu}`, filename = `yolostart-${target}`;
    const manifest = override
      ? JSON.parse((await download(`${RELEASE_BASE}${version}/manifest.json`, 1024 * 1024, fetchImpl)).toString())
      : pinned;
    const entry: Entry | undefined = manifest?.files?.[target];
    if (manifest?.version !== version || !entry || entry.file !== filename + ".gz"
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{64}$/.test(entry.executableSha256))
      throw Error("Invalid native release manifest.");
    const cacheHome = env.XDG_CACHE_HOME || path.join(env.HOME || homedir(), ".cache");
    if (!path.isAbsolute(cacheHome)) throw Error("XDG_CACHE_HOME must be an absolute path.");
    const dir = path.join(cacheHome, "yolostart", version);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await lstat(dir)).isDirectory()) throw Error("Invalid release cache directory.");
    let compressed = await cached(path.join(dir, entry.file));
    if (!compressed || digest(compressed) !== entry.sha256) {
      compressed = await download(`${RELEASE_BASE}${version}/${entry.file}`, LIMIT, fetchImpl);
      // Verify BOTH digests before publishing either cache file.
      const binary = unpack(compressed, entry);
      await atomicWrite(dir, entry.file, compressed, 0o600);
      await atomicWrite(dir, filename, binary, 0o700);
    } else {
      const binary = unpack(compressed, entry);
      const existing = await cached(path.join(dir, filename));
      if (!existing || digest(existing) !== entry.executableSha256)
        await atomicWrite(dir, filename, binary, 0o700);
      else await chmod(path.join(dir, filename), 0o700);
    }
    return path.join(dir, filename);
  } catch (error) {
    // Network/filesystem errors can contain URLs or private cache paths.
    const message = error instanceof Error && error.constructor === Error ? error.message : "Could not download or verify the native CLI.";
    throw Error(`${mode}: ${message} ${FALLBACK}`);
  }
}
export async function launch(args: string[], options: LaunchOptions = {}): Promise<number> {
  const executable = await resolveExecutable(options);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: { ...(options.env ?? process.env), YOLOSTART_ENTRYPOINT: "npm" } });
    const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    child.once("error", () => { cleanup(); reject(Error(`Could not start the native CLI. ${FALLBACK}`)); });
    child.once("close", (code, signal) => { cleanup(); resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)); });
  });
}
