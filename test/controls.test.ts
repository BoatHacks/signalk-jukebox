import { describe, it, expect, vi } from "vitest";
import {
  registerPlaybackControls,
  registerControlsMeta,
  PLAYBACK_CONTROL_PATHS,
  type ControlsAppLike,
  type SelfStream,
} from "../src/controls.js";
import type { MopidyClient } from "../src/mopidy-client.js";

function fakeApp(): {
  app: ControlsAppLike;
  emit: (path: string, value: unknown) => void;
} {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const streams = new Map<string, SelfStream>();
  for (const path of Object.values(PLAYBACK_CONTROL_PATHS)) {
    listeners.set(path, new Set());
    streams.set(path, {
      onValue(callback) {
        listeners.get(path)!.add(callback);
        return () => listeners.get(path)!.delete(callback);
      },
    });
  }
  return {
    app: {
      streambundle: {
        getSelfStream: (path) => {
          const stream = streams.get(path);
          if (!stream) throw new Error(`unexpected path ${path}`);
          return stream;
        },
      },
      error: vi.fn(),
    },
    emit: (path, value) => {
      for (const cb of listeners.get(path) ?? []) cb(value);
    },
  };
}

function fakeMopidy() {
  return {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    previous: vi.fn().mockResolvedValue(undefined),
  } as unknown as MopidyClient;
}

describe("registerPlaybackControls", () => {
  it("calls the matching Mopidy action on a 0->1 press", () => {
    const { app, emit } = fakeApp();
    const mopidy = fakeMopidy();
    registerPlaybackControls(app, mopidy);

    emit(PLAYBACK_CONTROL_PATHS.play, 1);
    expect(mopidy.play).toHaveBeenCalledTimes(1);
    expect(mopidy.pause).not.toHaveBeenCalled();
  });

  it("does not fire on release (1->0)", () => {
    const { app, emit } = fakeApp();
    const mopidy = fakeMopidy();
    registerPlaybackControls(app, mopidy);

    emit(PLAYBACK_CONTROL_PATHS.next, 1);
    emit(PLAYBACK_CONTROL_PATHS.next, 0);
    expect(mopidy.next).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire on a repeated 1 without an intervening release", () => {
    const { app, emit } = fakeApp();
    const mopidy = fakeMopidy();
    registerPlaybackControls(app, mopidy);

    emit(PLAYBACK_CONTROL_PATHS.previous, 1);
    emit(PLAYBACK_CONTROL_PATHS.previous, 1);
    expect(mopidy.previous).toHaveBeenCalledTimes(1);
  });

  it("fires again on a second press after a release", () => {
    const { app, emit } = fakeApp();
    const mopidy = fakeMopidy();
    registerPlaybackControls(app, mopidy);

    emit(PLAYBACK_CONTROL_PATHS.pause, 1);
    emit(PLAYBACK_CONTROL_PATHS.pause, 0);
    emit(PLAYBACK_CONTROL_PATHS.pause, 1);
    expect(mopidy.pause).toHaveBeenCalledTimes(2);
  });

  it("stops reacting once unsubscribed", () => {
    const { app, emit } = fakeApp();
    const mopidy = fakeMopidy();
    const stop = registerPlaybackControls(app, mopidy);

    stop();
    emit(PLAYBACK_CONTROL_PATHS.play, 1);
    expect(mopidy.play).not.toHaveBeenCalled();
  });
});

describe("registerControlsMeta", () => {
  it("publishes both meta and an initial value (0, released) for all four control paths", () => {
    const handleMessage = vi.fn();
    registerControlsMeta({ handleMessage }, "signalk-jukebox");

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const [pluginId, delta] = handleMessage.mock.calls[0] as [
      string,
      {
        updates: {
          meta: { path: string; value: unknown }[];
          values: { path: string; value: unknown }[];
        }[];
      },
    ];
    expect(pluginId).toBe("signalk-jukebox");

    const meta = delta.updates[0]!.meta;
    const metaPaths = meta.map((m) => m.path).sort();
    expect(metaPaths).toEqual(Object.values(PLAYBACK_CONTROL_PATHS).sort());
    for (const entry of meta) {
      expect(entry.value).toHaveProperty("description");
    }

    // Meta alone isn't enough for a path to show up anywhere in
    // /signalk/v1/api/...'s tree (confirmed live against a real running
    // server) -- a real value has to ship too, or the earlier "impossible
    // to find" report this function exists to fix stays unfixed.
    const values = delta.updates[0]!.values;
    const valuePaths = values.map((v) => v.path).sort();
    expect(valuePaths).toEqual(Object.values(PLAYBACK_CONTROL_PATHS).sort());
    for (const entry of values) {
      expect(entry.value).toBe(0);
    }
  });
});
