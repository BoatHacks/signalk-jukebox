// Persists the set of Wyoming bridge entry ids this plugin created a
// container for on its last start, so the NEXT start can tell "removed
// from settings" apart from "never existed" and reap the orphan.
//
// Why a file, not ContainerManagerApi.listContainers(): confirmed live
// against a real signalk-container that listContainers() does not
// report a container this plugin created in an earlier process
// lifetime at all (a live wyoming-bridge-* container, confirmed running
// via `podman ps` and confirmed removable by name through the manager's
// own REST API, was simply absent from listContainers()'s result) --
// it reflects the manager's own in-session bookkeeping, not a live host
// scan. A direct manager.remove(name) by a name THIS PLUGIN already
// knows works regardless, so tracking that name ourselves is the actual
// fix, not a workaround for a nicer API.
//
// Same atomic write-then-rename shape as zone-assignments-file.ts, into
// the same data directory.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_NAME = "wyoming-bridge-ids.json";

export async function loadKnownWyomingBridgeIds(
  dataDir: string,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(dataDir, FILE_NAME), "utf8");
  } catch (err) {
    // ENOENT (nothing persisted yet) is the expected steady state for a
    // fresh install or one that has never used this feature -- same
    // tolerance as loadZoneAssignments.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed;
    }
    return [];
  } catch {
    // Corrupt/unparseable -- recoverable, not fatal: worst case a
    // genuinely orphaned container from before this point is never
    // reaped (no persisted memory of it), but nothing crashes, and this
    // file's own next successful save overwrites it with valid JSON.
    return [];
  }
}

export async function saveKnownWyomingBridgeIds(
  dataDir: string,
  ids: string[],
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const finalPath = path.join(dataDir, FILE_NAME);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(ids, null, 2), "utf8");
  await rename(tmpPath, finalPath);
}
