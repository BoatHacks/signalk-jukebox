import type { StateStore } from "./state/store.js";
import type { SnapserverClient } from "./snapserver-client.js";

// Keeps the canonical store's zones in sync with Snapserver's actual state
// (ARCHITECTURE.md §2.2) -- polling rather than a push/event subscription
// because SnapserverClient's raw-socket transport (SPEC.md §13) doesn't
// currently surface Snapcast's own server-initiated notifications
// (Stream.OnUpdate etc.), only request/response.
//
// "MusicAndAlerts" is the fixed stream id a zone means by "playing the
// jukebox" (snapserver.conf.template's
// `source = meta:///Alerts/MopidyOnly?name=MusicAndAlerts`) -- a Snapcast
// meta stream that automatically plays whichever of Alerts/MopidyOnly is
// currently active, Alerts taking priority, so every zone on it auto-ducks
// for an announcement with no muting or reassignment needed. "MopidyOnly"
// itself (the raw Mopidy-backed stream meta reads from) is never a zone's
// own direct assignment anymore -- LEGACY_JUKEBOX_STREAM_IDS below exists
// only to catch zones still on an earlier name for "the jukebox" (this
// stream has been renamed twice: "Jukebox" before the meta stream existed
// at all, then "Output" before this rename to "MusicAndAlerts"/
// "MopidyOnly"). "Alerts" is the fixed stream id the announcement-intake
// stream always uses (same file's `source = tcp://...?name=Alerts&...`,
// container.ts's ALERTS_STREAM_ID) -- a zone manually switched there (src/
// routes.ts's /source endpoint) hears ONLY announcements, no jukebox at
// all, unlike MusicAndAlerts's auto-duck. "Silence" is the fixed stream id
// a zone is manually parked on (same endpoint) to hear literally nothing,
// not even announcements -- e.g. a sleeping cabin (same file's
// `source = pipe:///tmp/silencefifo?name=Silence&...`, fed continuously
// from /dev/zero by entrypoint.sh). Anything else a group's stream_id
// resolves to is that zone's own per-connection AirPlay stream (SPEC.md
// §6.4).

const JUKEBOX_STREAM_ID = "MusicAndAlerts";
const LEGACY_JUKEBOX_STREAM_IDS = ["Jukebox", "Output"];
const ALERTS_STREAM_ID = "Alerts";
const SILENCE_STREAM_ID = "Silence";
const DEFAULT_INTERVAL_MS = 2000;

// One-time migration (SPEC.md §12): a zone "playing the jukebox" has meant
// a direct Group.SetStream to a few different stream ids over time as this
// stream got introduced and renamed (LEGACY_JUKEBOX_STREAM_IDS' own
// comment above). Any zone still on one of those (its Snapcast-persisted
// group assignment survives container recreates) is moved onto the
// current JUKEBOX_STREAM_ID once, so it starts auto-ducking for
// announcements under the current name without the admin having to
// manually toggle it via the webapp. A zone already on the current name
// (by this migration or a real webapp click) is left alone.
export async function migrateZonesToCurrentJukeboxStream(
  snapserver: SnapserverClient,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const groups = await snapserver.getGroups();
    for (const group of groups) {
      if (LEGACY_JUKEBOX_STREAM_IDS.includes(group.streamId)) {
        await snapserver.setGroupStream(group.id, JUKEBOX_STREAM_ID);
      }
    }
  } catch (err) {
    onError(
      `signalk-jukebox: could not migrate zones to the ${JUKEBOX_STREAM_ID} stream: ${String(err)}`,
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
                  : group.streamId === SILENCE_STREAM_ID
                    ? "silence"
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
