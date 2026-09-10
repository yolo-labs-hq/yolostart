#!/usr/bin/env node
import { launch } from "./launcher.js";
try { process.exitCode = await launch(process.argv.slice(2)); }
catch (error) {
  console.error(`yolostart: ${error instanceof Error ? error.message : "Could not launch. Try: curl -fsSL https://yolostart.sh | sh"}`);
  process.exitCode = 1;
}
