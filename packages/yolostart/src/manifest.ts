import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { directoryRules, ignoredPath, type Rule } from "./ignore.js";
import { git } from "./git.js";
import { SKIP_DIRS, sensitiveJson, sensitivePath } from "./exclusions.js";
export interface TreeEntry {
  path: string;
  fileCount: number;
  bytes: number;
}
export interface Manifest {
  name: string;
  relPath: string;
  git: {
    remote: string | null;
    branch: string | null;
    lastCommitAt: string | null;
    dirty: boolean;
  } | null;
  fileCount: number;
  bytes: number;
  tree: TreeEntry[];
  excluded: {
    gitignored: number;
    sensitive: string[];
    oversize: string[];
    skipped: string[];
  };
}
// Do not expose embedded URL credentials in metadata either.
export function safeRemote(remote: string | null): string | null {
  if (!remote) return null;
  try {
    const url = new URL(remote);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol))
      return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(remote) ? remote : null;
  }
}
export async function buildManifest(
  root: string,
  scanRoot: string,
  isRepo: boolean,
): Promise<{ manifest: Manifest; includePaths: string[] }> {
  const manifest: Manifest = {
    name: path.basename(root),
    relPath: path.relative(scanRoot, root).split(path.sep).join("/") || ".",
    git: isRepo
      ? {
          remote: safeRemote(await git(root, "remote", "get-url", "origin")),
          branch: await git(root, "symbolic-ref", "--short", "HEAD"),
          lastCommitAt: await git(root, "log", "-1", "--format=%cI"),
          dirty:
            (await git(
              root,
              "status",
              "--porcelain",
              "--untracked-files=normal",
            )) !== "",
        }
      : null,
    fileCount: 0,
    bytes: 0,
    tree: [],
    excluded: { gitignored: 0, sensitive: [], oversize: [], skipped: [] },
  };
  const includePaths: string[] = [];
  const summary = new Map<string, TreeEntry>();
  async function visit(
    relative: string,
    inherited: Rule[],
    parentIgnored: boolean,
  ): Promise<void> {
    const dir = path.join(root, relative);
    const rules = await directoryRules(root, relative, inherited);
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(root, rel);
      if (sensitivePath(rel)) {
        manifest.excluded.sensitive.push(rel);
        continue;
      }
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        manifest.excluded.skipped.push(rel);
        continue;
      }
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
        manifest.excluded.skipped.push(rel);
        continue;
      }
      // Nested repositories are separate candidates, never part of this selection.
      if (entry.isDirectory() && entry.name !== ".git") {
        try {
          await lstat(path.join(full, ".git"));
          manifest.excluded.skipped.push(rel);
          continue;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      // A worktree's .git pointer is machine-local, not portable history.
      if (entry.name === ".git" && !entry.isDirectory()) {
        manifest.excluded.skipped.push(rel);
        continue;
      }
      const ignored =
        parentIgnored ||
        (rel !== ".git" &&
          !rel.startsWith(".git/") &&
          ignoredPath(rel, entry.isDirectory(), rules));
      if (entry.isDirectory()) {
        await visit(rel, rules, ignored);
        continue;
      }
      const info = await lstat(full);
      if (!info.isFile())
        throw new Error("Files changed during scan. Re-run yolostart.");
      if (info.size > 25 * 1024 * 1024) {
        manifest.excluded.oversize.push(rel);
        continue;
      }
      if (
        entry.name.toLowerCase().endsWith(".json") &&
        sensitiveJson(await readFile(full, "utf8"))
      ) {
        manifest.excluded.sensitive.push(rel);
        continue;
      }
      if (ignored) {
        manifest.excluded.gitignored++;
        continue;
      }
      if (includePaths.length >= 20_000)
        throw new Error(
          "Import exceeds 20,000 files. Narrow the project before re-running.",
        );
      includePaths.push(rel);
      manifest.fileCount++;
      manifest.bytes += info.size;
      const key = rel.split("/").slice(0, 2).join("/");
      // Reserve the last slot for overflow so no included counts disappear.
      const bucket =
        summary.has(key) || summary.size < 199 ? key : "[remaining paths]";
      const item = summary.get(bucket) ?? {
        path: bucket,
        fileCount: 0,
        bytes: 0,
      };
      item.fileCount++;
      item.bytes += info.size;
      summary.set(bucket, item);
    }
  }
  await visit("", [], false);
  manifest.tree = [...summary.values()];
  return { manifest, includePaths };
}
