// Momentary pushbutton inputs (SPEC.md §6.2, §6.5-style trigger). Unlike
// paths.ts (canonical state -> SK deltas, outward), this is the reverse
// direction: an external device (NMEA2000 switch, physical button wired
// through some other plugin, a webapp) publishes value=1 on press and
// value=0 on release to these paths, and this module is the *consumer* --
// same subscription mechanism ARCHITECTURE.md §2.5 already documents for
// the (stubbed) duck-triggers/vhf.ts and duck-triggers/voice.ts.
//
// These paths are read-only from the plugin's own point of view: nothing
// here calls app.handleMessage to publish them back out (paths.ts already
// owns entertainment.jukebox.playback.state/volume/track, which is the
// actual result of a press, not the press itself).

import type { MopidyClient } from "./mopidy-client.js";

export type PlaybackControlAction = "play" | "pause" | "next" | "previous";

/** SPEC.md §6.2. */
export const PLAYBACK_CONTROL_PATHS: Record<PlaybackControlAction, string> = {
  play: "entertainment.jukebox.playback.controls.play",
  pause: "entertainment.jukebox.playback.controls.pause",
  next: "entertainment.jukebox.playback.controls.next",
  previous: "entertainment.jukebox.playback.controls.previous",
};

/** Bacon.js's EventStream shape, as returned by app.streambundle.getSelfStream
 * -- onValue's return value IS the unsubscribe function (call it directly,
 * no `.dispose()` or similar). Typed narrowly here rather than pulling in
 * a Bacon.js dependency just for this. */
export interface SelfStream {
  onValue(callback: (value: unknown) => void): () => void;
}

export interface StreambundleLike {
  getSelfStream(path: string): SelfStream;
}

export interface ControlsAppLike {
  streambundle: StreambundleLike;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

/** A delta value counts as "pressed" the same way a physical switch path
 * would: any truthy/nonzero value, not strictly `=== 1` -- some sources
 * send booleans, and being lenient here costs nothing. */
function isPressed(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * Subscribes to all four `entertainment.jukebox.playback.controls.*` paths
 * and calls the matching MopidyClient method on each press (0/false -> 1/true
 * transition). Release (the matching 1 -> 0 transition) is intentionally a
 * no-op -- these are momentary triggers, not held-state controls -- and a
 * press path re-sending 1 without an intervening release (some drivers
 * republish current state periodically) is also a no-op, tracked per path
 * via the last-seen value, so a stuck/repeating source can't fire the same
 * action twice in a row.
 */
export function registerPlaybackControls(
  app: ControlsAppLike,
  mopidy: MopidyClient,
): () => void {
  const actions: Record<PlaybackControlAction, () => Promise<void>> = {
    play: () => mopidy.play(),
    pause: () => mopidy.pause(),
    next: () => mopidy.next(),
    previous: () => mopidy.previous(),
  };

  const unsubscribers = (
    Object.entries(actions) as [
      PlaybackControlAction,
      () => Promise<void>,
    ][]
  ).map(([action, run]) => {
    let lastPressed = false;
    return app.streambundle
      .getSelfStream(PLAYBACK_CONTROL_PATHS[action])
      .onValue((value) => {
        const pressed = isPressed(value);
        if (pressed && !lastPressed) {
          run().catch((err: unknown) => {
            app.error?.(`playback control "${action}" failed: ${String(err)}`);
          });
        }
        lastPressed = pressed;
      });
  });

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
