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
import {
  PLAYBACK_CONTROL_PATHS,
  type PlaybackControlAction,
} from "./controls.js";

/** SignalK's own convention for a level/percentage-like quantity is a
 * 0-1 ratio (paths.ts publishes these paths that way) -- a PUT to the
 * same path must accept the same shape it publishes, converted here to
 * the 0-100 integer Mopidy/Snapcast's own native APIs actually speak.
 * Returns null for anything outside 0-1 (including non-finite input). */
function ratioToPercent(value: unknown): number | null {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null;
  return Math.round(ratio * 100);
}

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
  app.registerPutHandler(
    SELF,
    "entertainment.jukebox.playback.volume",
    (_context, _path, value, callback) => {
      if (!mopidyState.client) {
        return {
          state: "COMPLETED",
          statusCode: 503,
          message: "container not ready yet",
        };
      }
      const volume = ratioToPercent(value);
      if (volume === null) {
        return {
          state: "COMPLETED",
          statusCode: 400,
          message: "volume must be a ratio, 0-1",
        };
      }
      mopidyState.client
        .setVolume(volume)
        .then(() => {
          store.setPlayback({ ...store.getPlayback(), volume });
          callback({ state: "COMPLETED", statusCode: 200 });
        })
        .catch((err: unknown) => {
          callback({
            state: "COMPLETED",
            statusCode: 502,
            message: String(err),
          });
        });
      return { state: "PENDING" };
    },
  );
}

/** A PUT value counts as "pressed" the same lenient way controls.ts's own
 * plain-delta-subscription path does (any truthy/nonzero value, not
 * strictly `=== 1`) -- kept consistent between the two ways of firing the
 * same action. `0`/`false` completes successfully as a no-op (the
 * "release" half of a momentary control), rather than erroring. */
function isPressedPutValue(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * Registers a real PUT handler for each of the four
 * `entertainment.jukebox.playback.controls.*` paths (SPEC.md §6.2) --
 * `controls.ts`'s own `registerControlsMeta`/`registerPlaybackControls`
 * only ever *subscribe* to these paths via `app.streambundle`, which
 * reacts to a delta from ANY source (another plugin calling
 * `app.handleMessage` directly, an N2K switch translation, etc) but does
 * NOT make the path answer a genuine SignalK PUT request -- that needs an
 * actual `registerPutHandler`, confirmed by reading signalk-server's own
 * source (`src/interfaces/plugins.ts`): the real `app.registerPutHandler`
 * wrapper automatically publishes `meta: [{path, value: {supportsPut:
 * true}}]` the moment it's called, merging into whatever meta
 * `registerControlsMeta` already published (`description`) -- so this is
 * also what makes `supportsPut: true` show up for these paths at all,
 * with no separate meta call needed here for that specific field.
 *
 * Unlike the momentary-switch delta subscription (which debounces a
 * repeated `1` sent without an intervening `0`, since a physical switch's
 * driver may republish current state periodically), a PUT is already a
 * single discrete request -- there's no continuous stream to debounce,
 * so every truthy PUT just fires the action once, unconditionally.
 */
export function registerPlaybackControlPutHandlers(
  app: PutHandlerAppLike,
  mopidyState: MopidyClientState,
): void {
  const actions: Record<PlaybackControlAction, () => Promise<unknown>> = {
    play: () => mopidyState.client!.play(),
    pause: () => mopidyState.client!.pause(),
    next: () => mopidyState.client!.next(),
    previous: () => mopidyState.client!.previous(),
  };

  for (const action of Object.keys(actions) as PlaybackControlAction[]) {
    app.registerPutHandler(
      SELF,
      PLAYBACK_CONTROL_PATHS[action],
      (_context, _path, value, callback) => {
        if (!isPressedPutValue(value)) {
          return { state: "COMPLETED", statusCode: 200 };
        }
        if (!mopidyState.client) {
          return {
            state: "COMPLETED",
            statusCode: 503,
            message: "container not ready yet",
          };
        }
        actions[action]()
          .then(() => callback({ state: "COMPLETED", statusCode: 200 }))
          .catch((err: unknown) => {
            callback({
              state: "COMPLETED",
              statusCode: 502,
              message: String(err),
            });
          });
        return { state: "PENDING" };
      },
    );
  }
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
          return {
            state: "COMPLETED",
            statusCode: 503,
            message: "container not ready yet",
          };
        }
        const zone = store.getZone(zoneId);
        if (!zone) {
          return {
            state: "COMPLETED",
            statusCode: 404,
            message: "unknown zone",
          };
        }
        const volume = ratioToPercent(value);
        if (volume === null) {
          return {
            state: "COMPLETED",
            statusCode: 400,
            message: "volume must be a ratio, 0-1",
          };
        }
        snapserverState.client
          .setClientVolume(zoneId, volume, zone.muted)
          .then(() => {
            store.setZone({ ...zone, volume });
            callback({ state: "COMPLETED", statusCode: 200 });
          })
          .catch((err: unknown) => {
            callback({
              state: "COMPLETED",
              statusCode: 502,
              message: String(err),
            });
          });
        return { state: "PENDING" };
      },
    );

    app.registerPutHandler(
      SELF,
      `entertainment.jukebox.zones.${zoneId}.muted`,
      (_context, _path, value, callback) => {
        if (!snapserverState.client) {
          return {
            state: "COMPLETED",
            statusCode: 503,
            message: "container not ready yet",
          };
        }
        const zone = store.getZone(zoneId);
        if (!zone) {
          return {
            state: "COMPLETED",
            statusCode: 404,
            message: "unknown zone",
          };
        }
        const muted = Boolean(value);
        snapserverState.client
          .setClientVolume(zoneId, zone.volume, muted)
          .then(() => {
            store.setZone({ ...zone, muted });
            callback({ state: "COMPLETED", statusCode: 200 });
          })
          .catch((err: unknown) => {
            callback({
              state: "COMPLETED",
              statusCode: 502,
              message: String(err),
            });
          });
        return { state: "PENDING" };
      },
    );
  };

  store.onChange(listener);
  return () => store.offChange(listener);
}
