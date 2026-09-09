import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
export async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "yolostart-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function file(
  root: string,
  name: string,
  contents = "fixture",
): Promise<void> {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), contents);
}
export async function repo(
  root: string,
  name: string,
  date?: string,
): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  if (date)
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    );
  return dir;
}
