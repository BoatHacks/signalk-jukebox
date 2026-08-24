// Persists StateStore's zoneAssignments (Snapclient id -> { n2kZone })
// across restarts (SPEC.md §8: "must survive restarts -- that's the entire
// point, 'Zone 1' on the MFD staying stable"), into the same data volume
// Mopidy/Snapserver's own state already lives in (container.ts's
// dataMount) -- this file just writes directly to app.getDataDirPath() on
// the host side, the same directory that mount bind-mounts into the
// container at /data, rather than going through the container at all
// (this is a plain Node.js plugin-process file, no container involved).
//
// Atomic write-then-rename (write to a .tmp path, then rename over the
// real one) so a crash mid-write can never leave a half-written,
// unparseable file behind -- the same pattern this org already uses for
// signalk-checklist's own per-list JSON files (lib/atomic-write.js there).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZoneAssignment } from "../types.js";

const FILE_NAME = "zone-assignments.json";

export async function loadZoneAssignments(
  dataDir: string,
): Promise<Record<string, ZoneAssignment>> {
  let raw: string;
  try {
    raw = await readFile(path.join(dataDir, FILE_NAME), "utf8");
  } catch (err) {
    // ENOENT (nothing persisted yet -- a fresh install) is the expected
    // steady state, not an error worth surfacing; anything else (a real
    // permissions problem, say) is worth the caller knowing about, so it
    // propagates rather than silently starting from empty.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, ZoneAssignment>;
    }
    return {};
  } catch {
    // Corrupt/unparseable file (e.g. truncated by a power loss mid-write
    // some way this module's own atomic rename doesn't cover -- an
    // external edit, a filesystem fault). Recoverable, not fatal: every
    // zone just re-claims a slot as if seen for the first time, and the
    // next successful save overwrites this file with valid JSON again.
    return {};
  }
}

export async function saveZoneAssignments(
  dataDir: string,
  assignments: Record<string, ZoneAssignment>,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const finalPath = path.join(dataDir, FILE_NAME);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(assignments, null, 2), "utf8");
  await rename(tmpPath, finalPath);
}
