import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { assertSafeCachePath } from "./paths.js";

function deadOwner(text: string): boolean {
  try {
    const owner: unknown = JSON.parse(text);
    const pid = (owner as { pid?: unknown } | null)?.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
    try {
      process.kill(pid as number, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    /* An incomplete owner record is not safe to reclaim. */
  }
  return false;
}

/** Serialize filesystem publication only; no provider work holds this lock. */
export async function withPublicationLock<T>(
  manifestPath: string,
  publish: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const path = `${manifestPath}.lock`;
  await assertSafeCachePath(path, true);
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + 10_000;
  while (true) {
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (handle) {
      try {
        await handle.writeFile(owner);
        await handle.sync();
        return await publish();
      } finally {
        await handle.close().catch(() => undefined);
        // Never remove a replacement owner's lock.
        const held = await readFile(path, "utf8").catch(() => undefined);
        if (held === owner || held === "")
          await rm(path, { force: true }).catch(() => undefined);
      }
    }
    await assertSafeCachePath(path);
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined && deadOwner(text)) {
      // Only one process may reclaim a dead owner. Otherwise two reapers can
      // both read the dead PID and the second can delete a newly acquired lock.
      const reaping = `${path}.reaping`;
      let acquired = false;
      try {
        await assertSafeCachePath(reaping);
        await mkdir(reaping, { mode: 0o700 });
        acquired = true;
        if ((await readFile(path, "utf8").catch(() => undefined)) === text)
          await rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        if (acquired) await rmdir(reaping).catch(() => undefined);
      }
    }
    if (Date.now() >= deadline)
      throw new Error(
        "Index publication lock timed out; confirm the lock owner has stopped before removing an incomplete lock",
      );
    await delay(25, undefined, { signal });
  }
}
