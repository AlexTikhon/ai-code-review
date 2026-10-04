import {
  nodeFileOps,
  type GenerationFileOps,
} from "../src/retrieval/index-generation.js";

export type FsOp =
  | "mkdir"
  | "create"
  | "write"
  | "sync"
  | "close"
  | "rename"
  | "remove"
  | "list"
  | "stat"
  | "syncDir";

export type FsEvent = {
  /** Ordinal of this call, 0-based, counting before/after pairs once. */
  step: number;
  op: FsOp;
  path: string;
  /** Target of a rename. */
  to?: string;
  phase: "before" | "after";
};

/** "crash": the process dies here. "fail": this one call throws, then life goes on. */
export type Decision = "crash" | "fail" | undefined;

export class SimulatedCrash extends Error {
  constructor() {
    super("simulated process crash");
  }
}

/**
 * The real filesystem with a fault injected at a chosen call. After a "crash"
 * every further call throws without touching the disk, which is what a dead
 * process does; the on-disk state is then exactly what a restart would find.
 */
export function faultyOps(
  decide: (event: FsEvent) => Decision = () => undefined,
) {
  const log: FsEvent[] = [];
  let crashed = false;
  let step = 0;
  const point = (
    op: FsOp,
    path: string,
    phase: "before" | "after",
    to?: string,
  ) => {
    if (crashed) throw new SimulatedCrash();
    const event: FsEvent = {
      step: phase === "before" ? ++step - 1 : step - 1,
      op,
      path,
      phase,
      ...(to ? { to } : {}),
    };
    log.push(event);
    const decision = decide(event);
    if (decision === "crash") {
      crashed = true;
      throw new SimulatedCrash();
    }
    if (decision === "fail") throw new Error("EIO: injected failure");
  };
  const wrap = async <T>(
    op: FsOp,
    path: string,
    run: () => Promise<T>,
    to?: string,
  ): Promise<T> => {
    point(op, path, "before", to);
    const result = await run();
    point(op, path, "after", to);
    return result;
  };
  const ops: GenerationFileOps = {
    mkdir: (path) => wrap("mkdir", path, () => nodeFileOps.mkdir(path)),
    async create(path) {
      point("create", path, "before");
      const writer = await nodeFileOps.create(path);
      try {
        point("create", path, "after");
      } catch (error) {
        await writer.close().catch(() => undefined); // a dead process holds no descriptors
        throw error;
      }
      return {
        write: (bytes) => wrap("write", path, () => writer.write(bytes)),
        sync: () => wrap("sync", path, () => writer.sync()),
        // A dead process holds no descriptors: release the real one even after a crash.
        close: () =>
          wrap("close", path, () => writer.close()).catch(async (error) => {
            await writer.close().catch(() => undefined);
            throw error;
          }),
      };
    },
    rename: (from, to) =>
      wrap("rename", from, () => nodeFileOps.rename(from, to), to),
    remove: (path) => wrap("remove", path, () => nodeFileOps.remove(path)),
    list: (path) => wrap("list", path, () => nodeFileOps.list(path)),
    stat: (path) => wrap("stat", path, () => nodeFileOps.stat(path)),
    syncDir: (path) => wrap("syncDir", path, () => nodeFileOps.syncDir(path)),
  };
  return { ops, log, crashed: () => crashed };
}
