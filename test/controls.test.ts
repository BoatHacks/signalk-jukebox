import { describe, it, expect, vi } from "vitest";
import {
  registerPlaybackControls,
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
