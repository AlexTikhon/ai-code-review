import { createHash } from "node:crypto";
import { lstat, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

function userCacheRoot(): string {
  return process.platform === "win32"
    ? join(homedir(), "AppData", "Local", "ai-code-reviewer")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ai-code-reviewer")
      : join(homedir(), ".cache", "ai-code-reviewer");
}

/** Repository contents never supply cache bytes or the cache destination. */
export function cacheDirectory(root: string, namespace: string): string {
  const repository = resolve(root);
  const identity =
    process.platform === "win32" ? repository.toLowerCase() : repository;
  const base = userCacheRoot();
  const key = createHash("sha256")
    .update(JSON.stringify([identity, namespace]))
    .digest("hex");
  const directory = join(base, key);
  const rel = relative(repository, directory);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    throw new Error("The user cache must be outside the reviewed repository");
  return directory;
}

/** Reject links/junctions on every component, including an existing target. */
export async function assertSafeCachePath(
  path: string,
  createParents = false,
): Promise<void> {
  const absolute = resolve(path);
  const volume = parse(absolute).root;
  const parts = absolute.slice(volume.length).split(sep).filter(Boolean);
  const cacheRoot = userCacheRoot();
  let current = volume;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const parent = i < parts.length - 1;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!parent || !createParents) continue;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink())
      throw new Error("Cache paths must not contain symlinks or junctions");
    if (
      process.getuid &&
      (current === cacheRoot || current.startsWith(`${cacheRoot}${sep}`))
    ) {
      if (info.uid !== process.getuid())
        throw new Error("Cache must belong to the current user");
      if (info.isDirectory() && (info.mode & 0o077) !== 0) {
        if (!createParents)
          throw new Error("Cache permissions must be owner-only");
        await chmod(current, 0o700);
      }
    }
    if (parent && !info.isDirectory())
      throw new Error("Cache parent is not a directory");
    if (!parent && !info.isFile() && !info.isDirectory())
      throw new Error("Cache target is not a regular file or directory");
  }
}

export async function ensureSafeCacheDirectory(path: string): Promise<void> {
  // A dummy child makes path itself a parent in the checked traversal.
  await assertSafeCachePath(join(path, ".directory-check"), true);
}
