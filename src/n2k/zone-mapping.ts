import type { ZoneAssignment } from "../types.js";

// "Claim the next free numbered n2kZone, once, forever" (SPEC.md §2, §12).
// AirPlay used to share this allocator for its stream pool, but that
// pool no longer exists (SPEC.md §6.4, §13 -- Snapcast can create/remove
// per-zone streams on demand, so there's nothing to number or persist);
// n2kZone is the only caller now, capped at 4 by the Fusion-Link protocol
// itself (confirmed, SPEC.md §13), not by anything Snapcast-related.

/** Fusion-Link's own hard zone cap (SPEC.md §6.3, §13, confirmed via
 * @canboat/ts-pgns's own fusionVolumes zone1-zone4 field layout) -- not a
 * number this plugin gets to choose. */
export const N2K_ZONE_CAP = 4;

/**
 * Returns the lowest n2kZone number in [0, cap) not already claimed by
 * any other zone's assignment, or undefined if the range is full
 * (SPEC.md §2 -- a zone beyond the cap simply gets no n2kZone, not an
 * error).
 */
export function nextFreeN2kZone(
  assignments: Record<string, ZoneAssignment>,
  cap: number,
): number | undefined {
  const taken = new Set(
    Object.values(assignments)
      .map((a) => a.n2kZone)
      .filter((n): n is number => n !== undefined),
  );
  for (let zone = 0; zone < cap; zone++) {
    if (!taken.has(zone)) return zone;
  }
  return undefined;
}

/**
 * Claims an n2kZone for `zoneId` if it doesn't already have one and the
 * range isn't full. Idempotent: if the zone already has one, returns it
 * unchanged rather than reassigning (SPEC.md §12 -- assignments are
 * permanent once made).
 */
export function claimN2kZone(
  assignments: Record<string, ZoneAssignment>,
  zoneId: string,
  cap: number,
): number | undefined {
  const existing = assignments[zoneId]?.n2kZone;
  if (existing !== undefined) return existing;

  const zone = nextFreeN2kZone(assignments, cap);
  if (zone === undefined) return undefined;

  assignments[zoneId] = { ...assignments[zoneId], n2kZone: zone };
  return zone;
}
