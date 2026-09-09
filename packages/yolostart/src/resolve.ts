import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { directoryRules, ignoredPath, type Rule } from "./ignore.js";
import { git } from "./git.js";
import { SKIP_DIRS, sensitivePath } from "./exclusions.js";
export interface Candidate {
  root: string;
  name: string;
  lastCommitAt: string | null;
  mtimeMs: number;
}
export interface Resolution {
  scanRoot: string;
  mode: "single" | "picker" | "plain";
  candidates: Candidate[];
}
async function candidate(root: string): Promise<Candidate> {
  return {
    root,
    name: path.basename(root),
    lastCommitAt: await git(root, "log", "-1", "--format=%cI"),
    mtimeMs: (await stat(root)).mtimeMs,
  };
}
export async function resolveProjects(start: string): Promise<Resolution> {
  const scanRoot = await realpath(start);
  if (!(await stat(scanRoot)).isDirectory())
    throw new Error("--scan must name a directory.");
  const root = await git(scanRoot, "rev-parse", "--show-toplevel");
  if (root)
    return {
      scanRoot,
      mode: "single",
      candidates: [await candidate(await realpath(root))],
    };
  const candidates: Candidate[] = [];
  async function visit(
    dir: string,
    depth: number,
    inherited: Rule[],
  ): Promise<void> {
    if (depth === 2) return;
    const relative = path.relative(scanRoot, dir).split(path.sep).join("/");
    const rules = await directoryRules(scanRoot, relative, inherited);
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        !entry.isDirectory() ||
        entry.name === ".git" ||
        SKIP_DIRS.has(entry.name) ||
        sensitivePath(entry.name)
      )
        continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignoredPath(rel, true, rules)) continue;
      const child = path.join(dir, entry.name);
      let marker = false;
      try {
        marker = !(await lstat(path.join(child, ".git"))).isSymbolicLink();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (
        marker &&
        (await git(child, "rev-parse", "--show-toplevel")) === child
      )
        candidates.push(await candidate(child));
      else await visit(child, depth + 1, rules);
    }
  }
  await visit(scanRoot, 0, []);
  candidates.sort(
    (a, b) =>
      (Date.parse(b.lastCommitAt ?? "") || 0) -
        (Date.parse(a.lastCommitAt ?? "") || 0) ||
      b.mtimeMs - a.mtimeMs ||
      a.root.localeCompare(b.root),
  );
  return {
    scanRoot,
    mode:
      candidates.length > 1 ? "picker" : candidates.length ? "single" : "plain",
    candidates,
  };
}
export function selectProject(
  resolution: Resolution,
  project?: string,
): Candidate | undefined {
  if (project) {
    const matches = resolution.candidates.filter(
      (c) =>
        c.name === project ||
        path.relative(resolution.scanRoot, c.root) === project,
    );
    if (matches.length !== 1)
      throw new Error(
        "--project must uniquely identify one discovered repo (use its relative path for duplicate names).",
      );
    return matches[0];
  }
  return resolution.mode === "single" ? resolution.candidates[0] : undefined;
}
