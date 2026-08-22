import type { SnapserverClient } from "../snapserver-client.js";
import type { ZoneActiveSource } from "../types.js";

// Switching a zone's audio source (SPEC.md §6.4, §2). Each zone
// (Snapclient) keeps its own single Snapcast group throughout its
// lifetime -- switching source is pointing that *same* group at a
// different stream (Group.SetStream), never moving the client between
// groups or creating one.
//
// Called on:
// - a zone's AirPlay stream transitioning to/from an active session
//   (detected via Snapserver reporting the stream's status, SPEC.md §3.2)
// - zone disconnect: no explicit call needed here -- the stream is
//   removed instead (receiver.ts), which unassigns the group automatically
//   (confirmed, SPEC.md §13)

export interface ZoneStreamIds {
  groupId: string;
  jukeboxStreamId: string;
  /** This zone's own AirPlay receiver stream id (receiver.ts). Absent
   * before the receiver has been created (e.g. briefly during zone
   * connect) -- switching to `airplay` is a no-op until it exists. */
  airplayStreamId?: string;
}

export async function switchZoneSource(
  client: SnapserverClient,
  target: ZoneStreamIds,
  source: ZoneActiveSource,
): Promise<void> {
  const streamId =
    source === "jukebox" ? target.jukeboxStreamId : target.airplayStreamId;
  if (!streamId) return;
  await client.setGroupStream(target.groupId, streamId);
}
