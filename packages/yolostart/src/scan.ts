import { resolveProjects, selectProject } from "./resolve.js";
import { buildManifest, type Manifest } from "./manifest.js";
export interface ScanManifest {
  mode: "single" | "picker" | "plain";
  candidates: (Manifest & { kind: "repo" | "adopt-dir" })[];
  otherRepos: string[];
}
// Metadata only. An explicit project flag narrows observation, but never grants
// upload permission. The future browser approval remains authoritative.
export async function scan(
  start: string,
  project?: string,
): Promise<ScanManifest> {
  const resolution = await resolveProjects(start);
  const selected = selectProject(resolution, project);
  const candidates = selected ? [selected] : resolution.candidates;
  const output: ScanManifest = {
    mode: selected ? "single" : resolution.mode,
    candidates: [],
    otherRepos: selected
      ? resolution.candidates.filter((c) => c !== selected).map((c) => c.name)
      : [],
  };
  if (resolution.mode === "plain") {
    const { manifest } = await buildManifest(
      resolution.scanRoot,
      resolution.scanRoot,
      false,
    );
    output.candidates.push({ kind: "adopt-dir", ...manifest });
  } else {
    for (const candidate of candidates) {
      const { manifest } = await buildManifest(
        candidate.root,
        resolution.scanRoot,
        true,
      );
      output.candidates.push({ kind: "repo", ...manifest });
    }
  }
  return output;
}
