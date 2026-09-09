import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export async function launch(
  args: string[],
  distribution: URL,
  platform = process.platform,
  arch = process.arch,
): Promise<number> {
  const cpu = arch === "x64" ? "amd64" : arch;
  if (
    !["linux", "darwin"].includes(platform) ||
    !["amd64", "arm64"].includes(cpu)
  ) {
    throw new Error("yolostart supports macOS/Linux on x64/arm64.");
  }
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", distribution), "utf8"),
  ) as {
    files: Record<
      string,
      { file: string; sha256: string; executableSha256: string }
    >;
  };
  const file = `yolostart-${platform}-${cpu}.gz`;
  const entry = manifest.files[`${platform}-${cpu}`];
  if (!entry || entry.file !== file)
    throw new Error("This npm package is missing its native executable.");
  const compressed = await readFile(new URL(file, distribution));
  const digest = (data: Buffer) =>
    createHash("sha256").update(data).digest("hex");
  if (digest(compressed) !== entry.sha256)
    throw new Error("Native executable checksum mismatch.");
  const binary = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  if (digest(binary) !== entry.executableSha256)
    throw new Error("Unpacked executable checksum mismatch.");
  const dir = await mkdtemp(path.join(tmpdir(), "yolostart-"));
  try {
    const executable = path.join(dir, "yolostart");
    await writeFile(executable, binary, { mode: 0o700 });
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: "inherit" });
      const interrupt = () => child.kill("SIGINT");
      const terminate = () => child.kill("SIGTERM");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
        resolve(
          code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
        );
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
