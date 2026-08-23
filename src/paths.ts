import type { StateStore, StateChangeEvent } from "./state/store.js";

// Publishes entertainment.jukebox.* deltas (SPEC.md §6.2) on every
// canonical-state change, regardless of which interface caused it. This
// is a pure subscriber: it never writes to the store itself. PUT handling
// for the PUT-able paths (playback.volume, zones.<id>.volume/muted) is
// registered separately in index.ts via app.registerPutHandler, and those
// handlers write to the store the same way a REST call would (routes.ts),
// not through this module.

export interface AppLike {
  handleMessage(pluginId: string, delta: unknown): void;
}

/** SignalK's real Meta shape (@signalk/server-api's MetaValue) has no
 * "type" field at all -- description + example is the spec-compliant way
 * to convey a value's shape/type, confirmed against that package's own
 * .d.ts. `example` is typed as a string there regardless of the path's
 * actual value type (a human-facing hint, not a schema), so numbers and
 * booleans are given as their string form. */
interface MetaEntry {
  path: string;
  value: { description: string; units?: string; example?: string };
}

const PLAYBACK_META: MetaEntry[] = [
  {
    path: "entertainment.jukebox.playback.state",
    value: {
      description:
        "Playback state: one of 'stopped', 'playing', or 'paused' (string)",
      example: "playing",
    },
  },
  {
    path: "entertainment.jukebox.playback.volume",
    value: {
      description: "Master playback volume, 0-100 (number)",
      units: "%",
      example: "50",
    },
  },
  {
    path: "entertainment.jukebox.playback.track",
    value: {
      description:
        "Currently playing track: { name: string, artist?: string, album?: string } (object). Present only while a track is playing/paused.",
    },
  },
];

function zoneMeta(zoneId: string): MetaEntry[] {
  return [
    {
      path: `entertainment.jukebox.zones.${zoneId}.connected`,
      value: {
        description:
          "Whether this zone's Snapclient is currently connected (boolean)",
        example: "true",
      },
    },
    {
      path: `entertainment.jukebox.zones.${zoneId}.volume`,
      value: {
        description: "This zone's Snapcast client volume, 0-100 (number)",
        units: "%",
        example: "50",
      },
    },
    {
      path: `entertainment.jukebox.zones.${zoneId}.muted`,
      value: {
        description: "Whether this zone is muted (boolean)",
        example: "false",
      },
    },
    {
      path: `entertainment.jukebox.zones.${zoneId}.n2kZone`,
      value: {
        description:
          "Assigned NMEA2000/Fusion-Link zone slot, 0-3 (number). Present only if this zone was ever assigned one (SPEC.md §2).",
        example: "0",
      },
    },
  ];
}

export function publishStateChanges(
  app: AppLike,
  pluginId: string,
  store: StateStore,
): () => void {
  // Static paths -- always exist regardless of state, so their meta is
  // known and sent once up front rather than waiting on a change event.
  app.handleMessage(pluginId, { updates: [{ meta: PLAYBACK_META }] });

  // Zone paths are dynamic (one set per Snapcast client id, discovered at
  // runtime) -- meta for a given zone id can only be sent once that id is
  // actually known, tracked here so a zone polled repeatedly (zone-sync.ts
  // ticks every 2s regardless of change) doesn't get its meta resent.
  const metaSentForZone = new Set<string>();

  const listener = (change: StateChangeEvent) => {
    const values =
      change.type === "playback"
        ? [
            {
              path: "entertainment.jukebox.playback.state",
              value: change.playback.state,
            },
            {
              path: "entertainment.jukebox.playback.volume",
              value: change.playback.volume,
            },
            ...(change.playback.track
              ? [
                  {
                    path: "entertainment.jukebox.playback.track",
                    value: {
                      name: change.playback.track.name,
                      artist: change.playback.track.artist,
                      album: change.playback.track.album,
                    },
                  },
                ]
              : []),
          ]
        : change.type === "zone"
          ? [
              {
                path: `entertainment.jukebox.zones.${change.zoneId}.connected`,
                value: change.zone.connected,
              },
              {
                path: `entertainment.jukebox.zones.${change.zoneId}.volume`,
                value: change.zone.volume,
              },
              {
                path: `entertainment.jukebox.zones.${change.zoneId}.muted`,
                value: change.zone.muted,
              },
              ...(change.zone.n2kZone !== undefined
                ? [
                    {
                      path: `entertainment.jukebox.zones.${change.zoneId}.n2kZone`,
                      value: change.zone.n2kZone,
                    },
                  ]
                : []),
            ]
          : [
              {
                path: `entertainment.jukebox.zones.${change.zoneId}.connected`,
                value: false,
              },
            ];

    const updates: unknown[] = [{ values }];
    if (change.type === "zone" && !metaSentForZone.has(change.zoneId)) {
      metaSentForZone.add(change.zoneId);
      updates.push({ meta: zoneMeta(change.zoneId) });
    }

    app.handleMessage(pluginId, { updates });
  };

  store.onChange(listener);
  return () => {
    store.offChange(listener);
  };
}
