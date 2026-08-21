import type { PluginSettings, ZoneAssignment } from "../types.js";
import { claimSlot } from "../n2k/zone-mapping.js";

// Static AirPlay stream pool (SPEC.md §6.4, ARCHITECTURE.md §2.2).
//
// Confirmed via research (SPEC.md §13): Snapcast cannot create
// `process`-type streams (which `airplay` is) at runtime -- deliberately
// blocked as part of the CVE-2023-36177 fix. So `airplay.maxZones`
// streams are declared once in Snapserver's static config at container
// start; a zone claims a slot the first time it's ever seen (persisted,
// see zone-mapping.ts), which requires regenerating that config and
// restarting Snapserver -- but only once, ever, per zone (SPEC.md §12).
//
// TODO(implementation): this module currently only computes *what* the
// config should say, not how to apply it -- writing snapserver.conf inside
// the running container and triggering a Snapserver-only restart (vs. a
// full container restart) needs a real mechanism, likely an exec/signal
// through signalk-container or a small control endpoint baked into the
// image. Not decided yet; ARCHITECTURE.md §9 flags this as open.

export interface AirplaySlotConfig {
  slot: number;
  /** shairport-sync display name; placeholder until a zone claims it. */
  name: string;
}

export function unclaimedSlotName(slot: number): string {
  return `Jukebox AirPlay (unassigned ${slot + 1})`;
}

export function claimedSlotName(
  pattern: string,
  boatName: string,
  zoneName: string,
): string {
  return pattern
    .replace("{boatName}", boatName)
    .replace("{zoneName}", zoneName);
}

/**
 * Computes the full pool config Snapserver's static config should declare,
 * given current persisted zone assignments and each zone's current
 * (possibly stale, for a disconnected zone) name.
 */
export function computePoolConfig(
  settings: PluginSettings,
  assignments: Record<string, ZoneAssignment>,
  zoneNames: Record<string, string>,
  boatName: string,
): AirplaySlotConfig[] {
  const slots: AirplaySlotConfig[] = [];
  const bySlot = new Map<number, string>(); // slot -> zoneId
  for (const [zoneId, a] of Object.entries(assignments)) {
    if (a.airplaySlot !== undefined) bySlot.set(a.airplaySlot, zoneId);
  }
  for (let slot = 0; slot < settings.airplay.maxZones; slot++) {
    const zoneId = bySlot.get(slot);
    const zoneName = zoneId ? zoneNames[zoneId] : undefined;
    slots.push({
      slot,
      name: zoneName
        ? claimedSlotName(settings.airplay.namePattern, boatName, zoneName)
        : unclaimedSlotName(slot),
    });
  }
  return slots;
}

/**
 * Claims a slot for a brand-new zone, if the pool has room. Returns the
 * claimed slot number, or undefined if the pool is full (SPEC.md §6.4 --
 * the zone simply has no AirPlay path, not an error). Caller is
 * responsible for regenerating Snapserver's config and restarting it when
 * this returns a newly-claimed slot (i.e. the assignment didn't already
 * exist) -- see the TODO above.
 */
export function claimAirplaySlot(
  assignments: Record<string, ZoneAssignment>,
  zoneId: string,
  maxZones: number,
): number | undefined {
  return claimSlot(assignments, zoneId, maxZones, "airplaySlot");
}
