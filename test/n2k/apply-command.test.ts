import { describe, it, expect, vi } from "vitest";
import { applyFusionCommand } from "../../src/n2k/apply-command.js";
import { StateStore, createInitialState } from "../../src/state/store.js";
import type { MopidyClient } from "../../src/mopidy-client.js";
import type { SnapserverClient } from "../../src/snapserver-client.js";

function fakeMopidy(): MopidyClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    previous: vi.fn().mockResolvedValue(undefined),
    setMute: vi.fn().mockResolvedValue(true),
  } as unknown as MopidyClient & Record<string, ReturnType<typeof vi.fn>>;
}

function fakeSnapserver(): SnapserverClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    setClientVolume: vi.fn().mockResolvedValue(undefined),
  } as unknown as SnapserverClient & Record<string, ReturnType<typeof vi.fn>>;
}

describe("applyFusionCommand", () => {
  it.each(["play", "pause", "next", "previous"] as const)(
    "dispatches %s to the matching MopidyClient method",
    async (type) => {
      const mopidy = fakeMopidy();
      const store = new StateStore(createInitialState());
      const onRequestStatus = vi.fn();

      await applyFusionCommand(
        { type },
        { mopidy, snapserver: null, store, onError: vi.fn(), onRequestStatus },
      );

      expect(mopidy[type]).toHaveBeenCalledTimes(1);
    },
  );

  it("is a silent no-op for a transport command when Mopidy isn't ready yet", async () => {
    const store = new StateStore(createInitialState());
    const onError = vi.fn();

    await applyFusionCommand(
      { type: "play" },
      { mopidy: null, snapserver: null, store, onError, onRequestStatus: vi.fn() },
    );

    expect(onError).not.toHaveBeenCalled();
  });

  it("applies zoneVolume to the zone with the matching n2kZone, through the real write path", async () => {
    const snapserver = fakeSnapserver();
    const store = new StateStore(createInitialState());
    store.setZone({
      id: "zone-a",
      groupId: "group-1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      n2kZone: 2,
      activeSource: "jukebox",
    });

    await applyFusionCommand(
      { type: "zoneVolume", n2kZone: 2, volume: 77 },
      { mopidy: null, snapserver, store, onError: vi.fn(), onRequestStatus: vi.fn() },
    );

    expect(snapserver.setClientVolume).toHaveBeenCalledWith("zone-a", 77, false);
    expect(store.getZone("zone-a")?.volume).toBe(77);
  });

  it("clamps zoneVolume into 0-100 and rounds it", async () => {
    const snapserver = fakeSnapserver();
    const store = new StateStore(createInitialState());
    store.setZone({
      id: "zone-a",
      groupId: "group-1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      n2kZone: 0,
      activeSource: "jukebox",
    });

    await applyFusionCommand(
      { type: "zoneVolume", n2kZone: 0, volume: 150.6 },
      { mopidy: null, snapserver, store, onError: vi.fn(), onRequestStatus: vi.fn() },
    );

    expect(snapserver.setClientVolume).toHaveBeenCalledWith("zone-a", 100, false);
  });

  it("is a no-op for zoneVolume when no zone claims that n2kZone", async () => {
    const snapserver = fakeSnapserver();
    const store = new StateStore(createInitialState());

    await applyFusionCommand(
      { type: "zoneVolume", n2kZone: 3, volume: 50 },
      { mopidy: null, snapserver, store, onError: vi.fn(), onRequestStatus: vi.fn() },
    );

    expect(snapserver.setClientVolume).not.toHaveBeenCalled();
  });

  it("applies masterMute through MopidyClient.setMute and updates the store", async () => {
    const mopidy = fakeMopidy();
    const store = new StateStore(createInitialState());

    await applyFusionCommand(
      { type: "masterMute", muted: true },
      { mopidy, snapserver: null, store, onError: vi.fn(), onRequestStatus: vi.fn() },
    );

    expect(mopidy.setMute).toHaveBeenCalledWith(true);
    expect(store.getPlayback().muted).toBe(true);
  });

  it("calls onRequestStatus for a requestStatus command, without touching Mopidy or Snapserver", async () => {
    const mopidy = fakeMopidy();
    const snapserver = fakeSnapserver();
    const store = new StateStore(createInitialState());
    const onRequestStatus = vi.fn();

    await applyFusionCommand(
      { type: "requestStatus" },
      { mopidy, snapserver, store, onError: vi.fn(), onRequestStatus },
    );

    expect(onRequestStatus).toHaveBeenCalledTimes(1);
    expect(mopidy.play).not.toHaveBeenCalled();
    expect(snapserver.setClientVolume).not.toHaveBeenCalled();
  });

  it("reports a backend failure via onError, rather than throwing", async () => {
    const mopidy = fakeMopidy();
    (mopidy.play as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));
    const store = new StateStore(createInitialState());
    const onError = vi.fn();

    await applyFusionCommand(
      { type: "play" },
      { mopidy, snapserver: null, store, onError, onRequestStatus: vi.fn() },
    );

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
  });
});
