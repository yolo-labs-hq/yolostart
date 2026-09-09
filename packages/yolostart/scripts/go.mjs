import { spawnSync } from "node:child_process";
const result = spawnSync(process.env.GO_BINARY || "go", process.argv.slice(2), {
  cwd: new URL("../native/", import.meta.url),
  stdio: "inherit",
});
if (result.error)
  console.error(
    "Building/testing requires Go 1.24+ on the developer machine (or set GO_BINARY).",
    result.error.message,
  );
process.exit(result.status ?? 1);
