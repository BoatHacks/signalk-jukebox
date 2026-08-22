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
 * Confirmed against Snapcast's actual source
 * (server/streamreader/airplay_stream.cpp): `name` and `devicename` are
 * two different things, easy to conflate. `name` is only this Snapcast
 * *stream's* own internal id (what shows up as a group's `stream_id`);
 * `devicename` is what actually becomes shairport-sync's `--name=`, the
 * real AirPlay mDNS-advertised device name an iPhone sees in its AirPlay
 * picker. An earlier version of this function only set `name`, which
 * would have left every zone's receiver showing up under shairport-
 * sync's same hardcoded default ("Snapcast") instead of its intended
 * per-zone name.
 *
 * `metadata_pipename` is NOT a real query parameter at all -- also
 * confirmed by reading the source: the metadata pipe path is
 * `/tmp/shairmeta.<pid>.<port>`, derived internally from the stream's
 * process id and port, not something the URI can set. metadata.ts needs
 * to discover the pipe path some other way (e.g. globbing /tmp for it),
 * not construct it from a parameter this function passes.
 *
 * `port` is real (confirmed) and lets a zone's RTSP port be pinned rather
 * than left at shairport-sync's own default (5000) -- Snapcast's airplay
 * stream type auto-increments on a bind conflict (also confirmed in the
 * source's onStderrMsg handling of "already running" from shairport-
 * sync), so concurrent zones don't collide even without us tracking
 * which ports are already taken.
 *
 * Deliberately not passing `controlscript=` (SPEC.md §6.4 -- open
 * Snapcast bug #1455 leaks that process on removal, and it isn't needed
 * for metadata anyway).
 *
 * The URI's path must be the executable's full path inside sandbox_dir
 * (`/app/sandbox/shairport-sync`, matching entrypoint.sh), not just
 * `/shairport-sync` -- confirmed by build-testing: Snapcast's containment
 * check resolves the bare filename via a PATH search, which finds this
 * image's apt-installed `/usr/bin/shairport-sync` first and rejects it
 * ("Process stream executable must be located in '/app/sandbox'") since
 * that copy isn't the sandboxed one.
 */
const SANDBOXED_SHAIRPORT_SYNC_PATH = "/app/sandbox/shairport-sync";

export function buildAirplayStreamUri(
  streamName: string,
  deviceName: string,
  port?: number,
): string {
  const params = new URLSearchParams({
    name: streamName,
    devicename: deviceName,
  });
  if (port !== undefined) params.set("port", String(port));
  return `airplay://${SANDBOXED_SHAIRPORT_SYNC_PATH}?${params.toString()}`;
}

export interface AirplayReceiver {
  streamId: string;
}

/** Creates a zone's AirPlay receiver. Does not touch the zone's group --
 * the new stream exists (and is mDNS-discoverable) but the zone keeps
 * playing the Jukebox stream until a session actually starts on it
 * (zone-binding.ts, SPEC.md §2's "connecting is the switch" rule).
 *
 * `port`, if given, pins the RTSP port Snapcast starts this zone's
 * shairport-sync on (confirmed real, receiver.ts's buildAirplayStreamUri
 * doc comment) -- needed to keep every zone's AirPlay traffic inside a
 * small, boundable port range this project can publish explicitly,
 * without per-zone dynamic port tracking (ARCHITECTURE.md §5, §6). */
export async function createReceiver(
  client: SnapserverClient,
  streamName: string,
  deviceName: string,
  port?: number,
): Promise<AirplayReceiver> {
  const { streamId } = await client.addStream(
    buildAirplayStreamUri(streamName, deviceName, port),
  );
  return { streamId };
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
