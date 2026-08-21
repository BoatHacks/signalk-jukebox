import type { SnapserverClient } from "../snapserver-client.js";
import type { ZoneActiveSource } from "../types.js";

// Dynamic client<->group/stream binding for an already-claimed AirPlay
// slot (SPEC.md §6.4). This is the fully-dynamic half of the pool design
// -- no restart, no config change, just Group.SetClients/SetStream against
// streams/groups that already exist from the static pool config (pool.ts).

export interface ZoneBindingTarget {
  snapclientId: string;
  jukeboxGroupId: string; // the shared Mopidy/Jukebox stream's group
  airplaySlotGroupId: string; // this zone's claimed slot's group
}

/**
 * Binds a zone's Snapclient to the given source. Called on:
 * - zone connect (bind to whichever source it was last on, default jukebox)
 * - zone disconnect (no-op on the Snapcast side -- the client just drops)
 * - an AirPlay session starting/ending on the zone's claimed slot (detected
 *   via Snapserver reporting the group's stream changed, SPEC.md §3.2)
 */
export async function bindZoneSource(
  client: SnapserverClient,
  target: ZoneBindingTarget,
  source: ZoneActiveSource,
): Promise<void> {
  const groupId =
    source === "jukebox" ? target.jukeboxGroupId : target.airplaySlotGroupId;
  await client.setClientStream(target.snapclientId, groupId);
}
