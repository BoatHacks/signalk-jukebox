import type { SnapserverClient } from "../snapserver-client.js";

// Per-zone AirPlay receiver create/remove (SPEC.md §6.4, §13; supersedes
// an earlier pre-provisioned-pool design built around a Snapcast RPC
// restriction that turned out to be version-specific, not permanent --
// see ARCHITECTURE.md §5 for the research this is based on).

export function receiverName(
  pattern: string,
  boatName: string,
  zoneName: string,
): string {
  return pattern
    .replace("{boatName}", boatName)
    .replace("{zoneName}", zoneName);
}

/**
 * Builds the `airplay://` stream URI passed to Stream.AddStream.
 *
 * TODO(verify): the `name` parameter is a safe bet -- every Snapcast
 * stream type accepts it for the mDNS/display name -- but the exact
 * query-parameter Snapcast's airplay stream type uses to enable and
 * locate shairport-sync's metadata pipe (SPEC.md §6.4) has not been
 * confirmed against Snapcast's source/docs. Confirm the actual parameter
 * name before relying on this producing a working metadata pipe; get the
 * stream *creating* and playing audio first, metadata is a layered-on
 * concern (types.ts's `ZoneAirPlayInfo.track` already treats it as
 * optional/absent-tolerant for exactly this kind of implementation gap).
 * Deliberately not passing `controlscript=` (SPEC.md §6.4 -- open
 * Snapcast bug #1455 leaks that process on removal, and it isn't needed
 * for metadata anyway).
 */
export function buildAirplayStreamUri(
  name: string,
  metadataPipePath: string,
): string {
  const params = new URLSearchParams({
    name,
    metadata_pipename: metadataPipePath, // TODO(verify) param name
  });
  return `airplay:///shairport-sync?${params.toString()}`;
}

export interface AirplayReceiver {
  streamId: string;
  metadataPipePath: string;
}

/** Creates a zone's AirPlay receiver. Does not touch the zone's group --
 * the new stream exists (and is mDNS-discoverable) but the zone keeps
 * playing the Jukebox stream until a session actually starts on it
 * (zone-binding.ts, SPEC.md §2's "connecting is the switch" rule). */
export async function createReceiver(
  client: SnapserverClient,
  name: string,
  metadataPipePath: string,
): Promise<AirplayReceiver> {
  const { streamId } = await client.addStream(
    buildAirplayStreamUri(name, metadataPipePath),
  );
  return { streamId, metadataPipePath };
}

/** Removes a zone's AirPlay receiver (SPEC.md §6.4) -- confirmed
 * (SPEC.md §13) to cleanly kill shairport-sync and unassign, not error,
 * any group still pointed at it. Callers should switch the zone's group
 * back to the Jukebox stream first if it was mid-session, rather than
 * relying on the unassign leaving it silent. */
export function removeReceiver(
  client: SnapserverClient,
  streamId: string,
): Promise<void> {
  return client.removeStream(streamId);
}
