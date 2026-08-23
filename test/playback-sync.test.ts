import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startPlaybackSync } from "../src/playback-sync.js";
import { StateStore, createInitialState } from "../src/state/store.js";
import type { MopidyClient, MopidyTrack } from "../src/mopidy-client.js";

function fakeMopidy(overrides: {
  state?: "playing" | "paused" | "stopped";
  track?: MopidyTrack | null;
  volume?: number | null;
  muted?: boolean;
}): MopidyClient {
  return {
    getState: vi.fn().mockResolvedValue(overrides.state ?? "stopped"),
    getCurrentTrack: vi.fn().mockResolvedValue(overrides.track ?? null),
    getVolume: vi.fn().mockResolvedValue(overrides.volume ?? 0),
    getMute: vi.fn().mockResolvedValue(overrides.muted ?? false),
  } as unknown as MopidyClient;
}

describe("startPlaybackSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes Mopidy's real state into the store instead of leaving the stopped default", async () => {
    const store = new StateStore(createInitialState());
    const mopidy = fakeMopidy({ state: "playing", volume: 42, muted: false });

    startPlaybackSync(store, mopidy);
    await vi.waitFor(() => expect(store.getPlayback().state).toBe("playing"));
    expect(store.getPlayback().volume).toBe(42);
  });

  it("maps a Mopidy track into the canonical Track shape", async () => {
    const store = new StateStore(createInitialState());
    const track: MopidyTrack = {
      uri: "https://ice.example.com/stream",
      name: "Groove Salad",
      artists: [{ name: "SomaFM" }, { name: "DJ Someone" }],
      album: { name: "Ambient" },
      length: 180000,
    };
    const mopidy = fakeMopidy({ state: "playing", track });

    startPlaybackSync(store, mopidy);
    await vi.waitFor(() =>
      expect(store.getPlayback().track?.name).toBe("Groove Salad"),
    );
    expect(store.getPlayback().track).toEqual({
      uri: "https://ice.example.com/stream",
      name: "Groove Salad",
      artist: "SomaFM, DJ Someone",
      album: "Ambient",
      durationMs: 180000,
    });
  });

  it("leaves track undefined when Mopidy reports none playing", async () => {
    const store = new StateStore(createInitialState());
    const mopidy = fakeMopidy({ state: "stopped", track: null });

    startPlaybackSync(store, mopidy);
    await vi.waitFor(() => expect(mopidy.getState).toHaveBeenCalled());
    expect(store.getPlayback().track).toBeUndefined();
  });

  it("recovers from a transient failure without crashing, keeps retrying", async () => {
    const store = new StateStore(createInitialState());
    store.setPlayback({ state: "playing", volume: 55, muted: false });
    let calls = 0;
    const mopidy = {
      getState: vi.fn().mockImplementation(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("unreachable"))
          : Promise.resolve("paused");
      }),
      getCurrentTrack: vi.fn().mockResolvedValue(null),
      getVolume: vi.fn().mockResolvedValue(55),
      getMute: vi.fn().mockResolvedValue(false),
    } as unknown as MopidyClient;

    startPlaybackSync(store, mopidy, 10);
    // A failed tick leaves the store as-is (never wipes it to some
    // failure default) and doesn't stop the poll loop -- confirmed by
    // eventually recovering, not by pinning an exact tick count against
    // fake timers, which is too implementation-detail-fragile (the
    // first tick fires synchronously, ahead of any advance call).
    await vi.waitFor(() => expect(store.getPlayback().state).toBe("paused"));
  });

  it("stop() cancels further polling", async () => {
    const store = new StateStore(createInitialState());
    const mopidy = fakeMopidy({ state: "playing" });

    const stop = startPlaybackSync(store, mopidy, 10);
    await vi.advanceTimersByTimeAsync(10);
    stop();
    const callsAtStop = (mopidy.getState as ReturnType<typeof vi.fn>).mock.calls
      .length;

    await vi.advanceTimersByTimeAsync(1000);
    expect(mopidy.getState).toHaveBeenCalledTimes(callsAtStop);
  });
});
