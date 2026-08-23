// PUT handling for the PUT-able paths SPEC.md §6.2 documents
// (`playback.volume`, `zones.<id>.volume`, `zones.<id>.muted`). Writes go
// through the real backend first (Mopidy/Snapserver), same as every other
// interface (routes.ts, controls.ts) -- a PUT is just another way to reach
// the same canonical-state write path, not a special case.
//
// `registerPutHandler` takes one exact, literal path per call -- no
// wildcard segment for a zone id -- so the two zone-scoped paths can only
// be registered once each zone id is actually known (zone-sync.ts's poll
// loop, via StateStore's "zone" change event), not up front like
// `playback.volume`. There is no unregisterPutHandler in the SignalK
// plugin API, so a zone that later disappears (Snapclient unplugged) just
// keeps a harmless, inert handler registered for its old id -- it will
// 404 ("unknown zone") if that id is ever reused before this plugin
// restarts, and reattach correctly once it reappears for real.

import type { StateStore, StateChangeEvent } from "./state/store.js";
import type { MopidyClient } from "./mopidy-client.js";
import type { SnapserverClientState } from "./routes.js";

export interface ActionResult {
  state: "COMPLETED" | "PENDING" | "FAILED";
  statusCode?: number;
  message?: string;
}

export type ActionHandler = (
  context: string,
  path: string,
  value: unknown,
  callback: (result: ActionResult) => void,
) => ActionResult;

export interface PutHandlerAppLike {
  registerPutHandler(
    context: string,
    path: string,
    callback: ActionHandler,
    source?: string,
  ): void;
}

const SELF = "vessels.self";

/** Mutable box for the real MopidyClient -- registerPlaybackVolumePutHandler
 * runs at plugin start(), synchronously, before container.start() resolves
 * and the client can be constructed against its real address (same
 * "container not ready yet" pattern as routes.ts's SnapserverClientState /
 * proxy.ts's MopidyProxyState). */
export interface MopidyClientState {
  client: MopidyClient | null;
}

export function registerPlaybackVolumePutHandler(
  app: PutHandlerAppLike,
  mopidyState: MopidyClientState,
  store: StateStore,
): void {
  app.registerPutHandler(SELF, "entertainment.jukebox.playback.volume", (
    _context,
    _path,
    value,
    callback,
  ) => {
    if (!mopidyState.client) {
      return { state: "COMPLETED", statusCode: 503, message: "container not ready yet" };
    }
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return { state: "COMPLETED", statusCode: 400, message: "volume must be 0-100" };
    }
    mopidyState.client
      .setVolume(volume)
      .then(() => {
        store.setPlayback({ ...store.getPlayback(), volume });
        callback({ state: "COMPLETED", statusCode: 200 });
      })
      .catch((err: unknown) => {
        callback({ state: "COMPLETED", statusCode: 502, message: String(err) });
      });
    return { state: "PENDING" };
  });
}

/**
 * Subscribes to the store's own "zone" events and registers this pair of
 * PUT handlers the first time each zone id is seen -- tracked in-memory
 * (`registered`) so the 2s zone-sync poll (which calls `setZone` every
 * tick regardless of whether anything changed) doesn't attempt the same
 * registration over and over.
 */
export function registerZonePutHandlers(
  app: PutHandlerAppLike,
  snapserverState: SnapserverClientState,
  store: StateStore,
): () => void {
  const registered = new Set<string>();

  const listener = (change: StateChangeEvent) => {
    if (change.type !== "zone" || registered.has(change.zoneId)) return;
    registered.add(change.zoneId);
    const zoneId = change.zoneId;

    app.registerPutHandler(
      SELF,
      `entertainment.jukebox.zones.${zoneId}.volume`,
      (_context, _path, value, callback) => {
        if (!snapserverState.client) {
          return { state: "COMPLETED", statusCode: 503, message: "container not ready yet" };
        }
        const zone = store.getZone(zoneId);
        if (!zone) {
          return { state: "COMPLETED", statusCode: 404, message: "unknown zone" };
        }
        const volume = Number(value);
        if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
          return { state: "COMPLETED", statusCode: 400, message: "volume must be 0-100" };
        }
        snapserverState.client
          .setClientVolume(zoneId, volume, zone.muted)
          .then(() => {
            store.setZone({ ...zone, volume });
            callback({ state: "COMPLETED", statusCode: 200 });
          })
          .catch((err: unknown) => {
            callback({ state: "COMPLETED", statusCode: 502, message: String(err) });
          });
        return { state: "PENDING" };
      },
    );

    app.registerPutHandler(
      SELF,
      `entertainment.jukebox.zones.${zoneId}.muted`,
      (_context, _path, value, callback) => {
        if (!snapserverState.client) {
          return { state: "COMPLETED", statusCode: 503, message: "container not ready yet" };
        }
        const zone = store.getZone(zoneId);
        if (!zone) {
          return { state: "COMPLETED", statusCode: 404, message: "unknown zone" };
        }
        const muted = Boolean(value);
        snapserverState.client
          .setClientVolume(zoneId, zone.volume, muted)
          .then(() => {
            store.setZone({ ...zone, muted });
            callback({ state: "COMPLETED", statusCode: 200 });
          })
          .catch((err: unknown) => {
            callback({ state: "COMPLETED", statusCode: 502, message: String(err) });
          });
        return { state: "PENDING" };
      },
    );
  };

  store.onChange(listener);
  return () => store.offChange(listener);
}
