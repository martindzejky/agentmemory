// Container-level memory, i.e. the number that actually gets the process killed.
//
// The health monitor only ever reported the Node worker's process.memoryUsage(),
// and its memory alert compares heapUsed to heapTotal — a heap *utilisation*
// ratio. That number can sit at a comfortable 40% while the container is 200 MB
// from an OOM kill, because the iii-engine runs as a separate child process
// holding the SQLite state store and is not measured at all. Measured during the
// investigation: worker RSS 367 MB against an engine at 1120 MB.
//
// The cgroup accounts for everything in the container, so it is the only figure
// that can predict the kill, and reading it needs no knowledge of the engine's
// pid.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ContainerMemory {
  usedBytes: number;
  limitBytes: number | null;
  percent: number | null;
}

const CGROUP_ROOT = "/sys/fs/cgroup";

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readNumber(path: string): number | null {
  const raw = readRaw(path);
  if (raw === null || raw === "max") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Two layouts have to work. Inside a container with its own cgroup namespace
// (Docker, Railway) the controller files sit directly at the mount root. On a
// host or in a shared namespace they only exist inside the process's own cgroup,
// because the v2 root never exposes memory.current. Trying the root first keeps
// the common containerised case to a single file read.
function cgroupV2Dirs(): string[] {
  const dirs = [CGROUP_ROOT];
  const self = readRaw("/proc/self/cgroup");
  if (self) {
    for (const line of self.split("\n")) {
      // v2 lines look like "0::/system.slice/whatever".
      const path = line.startsWith("0::") ? line.slice(3) : null;
      if (path && path !== "/") dirs.push(join(CGROUP_ROOT, path));
    }
  }
  return dirs;
}

// A limit is frequently set on an ancestor rather than on the leaf, so walk up
// until one appears. Returns the tightest limit found on the way to the root.
function findLimit(dir: string): number | null {
  let current = dir;
  let limit: number | null = null;
  for (let depth = 0; depth < 16; depth++) {
    const value = readNumber(join(current, "memory.max"));
    if (value !== null) limit = limit === null ? value : Math.min(limit, value);
    if (current === CGROUP_ROOT || current === "/") break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return limit;
}

export function readContainerMemory(): ContainerMemory | null {
  for (const dir of cgroupV2Dirs()) {
    const used = readNumber(join(dir, "memory.current"));
    if (used === null) continue;
    const limit = findLimit(dir);
    return {
      usedBytes: used,
      limitBytes: limit,
      percent: limit && limit > 0 ? (used / limit) * 100 : null,
    };
  }

  // cgroup v1.
  const v1Used = readNumber(`${CGROUP_ROOT}/memory/memory.usage_in_bytes`);
  if (v1Used !== null) {
    const limit = readNumber(`${CGROUP_ROOT}/memory/memory.limit_in_bytes`);
    // v1 reports "no limit" as a sentinel near 2^63, not as "max".
    const sane = limit !== null && limit > 0 && limit < 2 ** 62 ? limit : null;
    return {
      usedBytes: v1Used,
      limitBytes: sane,
      percent: sane ? (v1Used / sane) * 100 : null,
    };
  }

  return null;
}
