import type { StateStore } from "./state/store.js";
import type { SnapserverClient } from "./snapserver-client.js";

// Keeps the canonical store's zones in sync with Snapserver's actual state
// (ARCHITECTURE.md §2.2) -- polling rather than a push/event subscription
// because SnapserverClient's raw-socket transport (SPEC.md §13) doesn't
// currently surface Snapcast's own server-initiated notifications
// (Stream.OnUpdate etc.), only request/response.
//
// "Jukebox" is the fixed stream id the shared Mopidy-backed stream always
// uses (snapserver.conf.template's `source = pipe://...?name=Jukebox&...`);
// "Alerts" is the fixed stream id the announcement-intake stream always
// uses (same file's `source = tcp://...?name=Alerts&...`, container.ts's
// ALERTS_STREAM_ID) -- a zone manually switched there (src/routes.ts's
// /source endpoint) still hears announcements without being muted
// entirely. Anything else a group's stream_id resolves to is that zone's
// own per-connection AirPlay stream (SPEC.md §6.4).

const JUKEBOX_STREAM_ID = "Jukebox";
const ALERTS_STREAM_ID = "Alerts";
const DEFAULT_INTERVAL_MS = 2000;

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
