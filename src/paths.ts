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

export function publishStateChanges(
  app: AppLike,
  pluginId: string,
  store: StateStore,
): () => void {
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

    app.handleMessage(pluginId, {
      updates: [{ values }],
    });
  };

  store.onChange(listener);
  return () => {
    store.offChange(listener);
  };
}
