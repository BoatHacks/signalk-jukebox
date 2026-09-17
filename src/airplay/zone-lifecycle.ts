import type { SnapserverClient } from "../snapserver-client.js";
import { receiverName, buildAirplayStreamUri } from "./receiver.js";
import { switchZoneSource } from "./zone-binding.js";

// Orchestrates receiver.ts and zone-binding.ts against live Snapserver
// state (SPEC.md §6.4) -- the piece that was never actually wired into
// index.ts despite both of those modules being fully written: confirmed
// live against a real signalk-jukebox install that zero airplay:// streams
// ever existed (only the 4 static streams snapserver.conf.template
// declares), so no AirPlay receiver had ever been created for any zone,
// on any iOS version, independent of the separate AirPlay-1-vs-2 gap.
//
// Polling, not a Stream.OnUpdate subscription, for the same reason
// zone-sync.ts already polls (see that file's own comment) --
// SnapserverClient's raw-socket transport doesn't currently surface
// Snapcast's server-initiated notifications, only request/response.
// A separate poller/interval from zone-sync.ts's own, not folded into its
// tick: this project already runs multiple independent Snapserver
// pollers at once (wyoming-bridge.ts's mute poll is another), and keeping
// this one isolated means a bug here can't touch zone-sync's already
// well-exercised n2kZone-claiming logic.

const JUKEBOX_STREAM_ID = "MusicAndAlerts";
const DEFAULT_INTERVAL_MS = 2000;

interface TrackedReceiver {
  streamId: string;
  deviceName: string;
}

export interface AirplayZoneSyncAppLike {
  getSelfPath(path: string): unknown;
}

export function startAirplayZoneSync(
  snapserver: SnapserverClient,
  app: AirplayZoneSyncAppLike,
  namePattern: string,
  onError: (message: string) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  // Keyed by zone (Snapclient) id -- not persisted (SPEC.md §6.4: "created
  // removed on demand", no equivalent of the N2K zone-assignment file).
  const receivers = new Map<string, TrackedReceiver>();

  const boatName = () => {
    const name = app.getSelfPath("name");
    return typeof name === "string" && name.length > 0 ? name : "Boat";
  };

  // SPEC.md §6.4: "if two zones would produce the same advertised name...
  // the plugin must disambiguate rather than silently advertise two
  // identical AirPlay targets." Only the human-visible devicename needs
  // this -- the internal Snapcast stream id below is already unique by
  // construction (derived from the zone's own id).
  const uniqueDeviceName = (proposed: string, zoneId: string): string => {
    for (const [otherId, other] of receivers) {
      if (otherId !== zoneId && other.deviceName === proposed) {
        return `${proposed} (${zoneId})`;
      }
    }
    return proposed;
  };

  const tick = async () => {
    try {
      const [groups, streamStatuses] = await Promise.all([
        snapserver.getGroups(),
        snapserver.getStreamStatuses(),
      ]);
      const seen = new Set<string>();

      for (const group of groups) {
        for (const client of group.clients) {
          if (!client.connected) continue;
          seen.add(client.id);

          let receiver = receivers.get(client.id);
          if (!receiver) {
            const deviceName = uniqueDeviceName(
              receiverName(namePattern, boatName(), client.name),
              client.id,
            );
            const streamName = `airplay-${client.id}`;
            const { streamId } = await snapserver.addStream(
              buildAirplayStreamUri(streamName, deviceName),
            );
            receiver = { streamId, deviceName };
            receivers.set(client.id, receiver);
          }

          // "Connecting is the switch" (SPEC.md §2, §6.4, §12): a zone's
          // AirPlay stream is never chosen manually (routes.ts's own
          // /source endpoint explicitly rejects "airplay") -- an actual
          // AirPlay session starting/ending on this zone's own receiver
          // is what flips its group over and back, regardless of
          // whatever passive source (jukebox/alerts/silence) it was on.
          const isPlaying = streamStatuses[receiver.streamId] === "playing";
          const onAirplayNow = group.streamId === receiver.streamId;
          if (isPlaying && !onAirplayNow) {
            await switchZoneSource(
              snapserver,
              {
                groupId: group.id,
                jukeboxStreamId: JUKEBOX_STREAM_ID,
                airplayStreamId: receiver.streamId,
              },
              "airplay",
            );
          } else if (!isPlaying && onAirplayNow) {
            await switchZoneSource(
              snapserver,
              { groupId: group.id, jukeboxStreamId: JUKEBOX_STREAM_ID },
              "jukebox",
            );
          }
        }
      }

      for (const [zoneId, receiver] of receivers) {
        if (!seen.has(zoneId)) {
          await snapserver.removeStream(receiver.streamId);
          receivers.delete(zoneId);
        }
      }
    } catch (err) {
      onError(`signalk-jukebox: AirPlay zone sync failed: ${String(err)}`);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
