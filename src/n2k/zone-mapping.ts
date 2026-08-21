import type { ZoneAssignment } from "../types.js";

// Shared "claim the next free numbered slot, once, forever" allocator used
// by both the N2K zone mapping (SPEC.md §2) and the AirPlay slot pool
// (SPEC.md §6.4) -- same rule, two different capped ranges (n2kZone: 0-3;
// airplaySlot: 0..maxZones-1).

/**
 * Returns the lowest slot number in [0, cap) not already claimed by any
 * other zone's assignment, or undefined if the pool is full (SPEC.md §2 —
 * a zone beyond the cap simply gets no slot, not an error).
 */
export function nextFreeSlot(
  assignments: Record<string, ZoneAssignment>,
  cap: number,
  field: "n2kZone" | "airplaySlot",
): number | undefined {
  const taken = new Set(
    Object.values(assignments)
      .map((a) => a[field])
      .filter((n): n is number => n !== undefined),
  );
  for (let slot = 0; slot < cap; slot++) {
    if (!taken.has(slot)) return slot;
  }
  return undefined;
}

/**
 * Claims a slot for `zoneId` in `field` if it doesn't already have one and
 * the pool isn't full. Idempotent: if the zone already has a slot, returns
 * it unchanged rather than reassigning (SPEC.md §12 — assignments are
 * permanent once made).
 */
export function claimSlot(
  assignments: Record<string, ZoneAssignment>,
  zoneId: string,
  cap: number,
  field: "n2kZone" | "airplaySlot",
): number | undefined {
  const existing = assignments[zoneId]?.[field];
  if (existing !== undefined) return existing;

  const slot = nextFreeSlot(assignments, cap, field);
  if (slot === undefined) return undefined;

  assignments[zoneId] = { ...assignments[zoneId], [field]: slot };
  return slot;
}
