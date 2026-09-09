#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { launch } from "./launcher.js";
try {
  const { version } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  process.exitCode = await launch(
    process.argv.slice(2),
    new URL(`./native/${version}/`, import.meta.url),
  );
} catch (error) {
  console.error(
    `yolostart: ${error instanceof Error ? error.message : "Could not launch the native executable."}`,
  );
  process.exitCode = 1;
}
