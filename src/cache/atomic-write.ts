import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { assertSafeCachePath } from "./paths.js";

/** Write-then-rename so readers never observe a partially written cache file. */
export async function writeFileAtomic(
  path: string,
  contents: string,
): Promise<void> {
  await assertSafeCachePath(path, true);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
