import type { StateStore } from "./state/store.js";
import type { SnapserverClient } from "./snapserver-client.js";

// Keeps the canonical store's zones in sync with Snapserver's actual state
// (ARCHITECTURE.md §2.2) -- polling rather than a push/event subscription
// because SnapserverClient's raw-socket transport (SPEC.md §13) doesn't
// currently surface Snapcast's own server-initiated notifications
// (Stream.OnUpdate etc.), only request/response.
//
// "Output" is the fixed stream id a zone means by "playing the jukebox"
// (snapserver.conf.template's `source = meta:///Alerts/Jukebox?name=Output`)
// -- a Snapcast meta stream that automatically plays whichever of Alerts/
// Jukebox is currently active, Alerts taking priority, so every zone on it
// auto-ducks for an announcement with no muting or reassignment needed.
// "Jukebox" itself (the raw Mopidy-backed stream meta reads from) is never
// a zone's own direct assignment anymore -- MIGRATION_JUKEBOX_STREAM_ID
// below exists only to catch zones still on it from before this stream was
// introduced. "Alerts" is the fixed stream id the announcement-intake
// stream always uses (same file's `source = tcp://...?name=Alerts&...`,
// container.ts's ALERTS_STREAM_ID) -- a zone manually switched there (src/
// routes.ts's /source endpoint) hears ONLY announcements, no jukebox at
// all, unlike Output's auto-duck. Anything else a group's stream_id
// resolves to is that zone's own per-connection AirPlay stream (SPEC.md
// §6.4).

const JUKEBOX_STREAM_ID = "Output";
const MIGRATION_JUKEBOX_STREAM_ID = "Jukebox";
const ALERTS_STREAM_ID = "Alerts";
const DEFAULT_INTERVAL_MS = 2000;

// One-time migration (SPEC.md §12): before the Output meta stream existed,
// a zone "playing the jukebox" meant a direct Group.SetStream to "Jukebox".
// Any zone still on that raw stream (its Snapcast-persisted group
// assignment survives container recreates) is moved onto "Output" once, so
// it starts auto-ducking for announcements without the admin having to
// manually toggle it via the webapp. A zone already reassigned (by this
// migration or a real "Play here" click) is left alone -- this only
// touches groups still literally on "Jukebox".
export async function migrateZonesToOutputStream(
  snapserver: SnapserverClient,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const groups = await snapserver.getGroups();
    for (const group of groups) {
      if (group.streamId === MIGRATION_JUKEBOX_STREAM_ID) {
        await snapserver.setGroupStream(group.id, JUKEBOX_STREAM_ID);
      }
    }
  } catch (err) {
    onError(
      `signalk-jukebox: could not migrate zones from the raw Jukebox stream to Output: ${String(err)}`,
    );
  }
}

export function startZoneSync(
  store: StateStore,
  snapserver: SnapserverClient,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      const groups = await snapserver.getGroups();
      const seen = new Set<string>();
      for (const group of groups) {
        for (const client of group.clients) {
          seen.add(client.id);
          const existing = store.getZone(client.id);
          store.setZone({
            id: client.id,
            groupId: group.id,
            name: client.name,
            connected: client.connected,
            volume: client.volume,
            muted: client.muted,
            activeSource:
              group.streamId === JUKEBOX_STREAM_ID
                ? "jukebox"
                : group.streamId === ALERTS_STREAM_ID
                  ? "alerts"
                  : "airplay",
            n2kZone: existing?.n2kZone,
            airplay: existing?.airplay,
          });
        }
      }
      for (const zone of store.getZones()) {
        if (!seen.has(zone.id)) store.removeZone(zone.id);
      }
    } catch {
      // Transient/unreachable -- leave existing store state, retry next tick.
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
