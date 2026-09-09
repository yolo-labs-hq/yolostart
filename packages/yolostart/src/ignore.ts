import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
export interface Rule {
  base: string;
  matcher: Ignore;
}
export async function directoryRules(
  root: string,
  relative: string,
  inherited: Rule[],
): Promise<Rule[]> {
  const rules = [...inherited];
  const filename = path.join(root, relative, ".gitignore");
  try {
    const info = await lstat(filename);
    if (info.isFile()) {
      if (info.size > 1024 * 1024)
        throw new Error(
          ".gitignore exceeds 1 MiB; refusing to silently ignore its rules.",
        );
      rules.push({
        base: relative,
        matcher: ignore().add(await readFile(filename, "utf8")),
      });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return rules;
}
export function ignoredPath(
  relative: string,
  directory: boolean,
  rules: Rule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    const sub = rule.base ? relative.slice(rule.base.length + 1) : relative;
    const result = rule.matcher.test(sub + (directory ? "/" : ""));
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}
