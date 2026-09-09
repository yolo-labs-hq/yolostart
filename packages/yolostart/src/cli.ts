#!/usr/bin/env node
import { parseArgs } from "node:util";
import { deviceAuth } from "./auth.js";
import { scan } from "./scan.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scan: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: yolostart --dry-run [--scan <directory>] [--project <name-or-relative-path>]\nSigns in and prints candidate metadata. Nothing uploads.\nAll import decisions belong to browser approval (not yet available).",
    );
    return;
  }
  if (!values["dry-run"])
    throw new Error(
      "Import is not yet available. Use --dry-run to preview a manifest; nothing will upload.",
    );
  await deviceAuth();
  const manifest = await scan(values.scan ?? process.cwd(), values.project);
  console.error(
    "Dry run only. Nothing uploaded. Excluded secrets must be supplied separately in the workspace.",
  );
  console.log(JSON.stringify(manifest, null, 2));
}
main().catch((error) => {
  console.error(
    `yolostart: ${error instanceof Error ? error.message : "Failed."}`,
  );
  process.exitCode = 1;
});
