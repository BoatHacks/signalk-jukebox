import { describe, it, expect, vi } from "vitest";
import { StateStore, createInitialState } from "../src/state/store.js";
import type { Zone } from "../src/types.js";

const zone: Zone = {
  id: "cockpit",
  name: "Cockpit",
  connected: true,
  volume: 50,
  muted: false,
  activeSource: "jukebox",
};

describe("StateStore", () => {
  it("starts stopped with no zones", () => {
    const store = new StateStore(createInitialState());
    expect(store.getPlayback().state).toBe("stopped");
    expect(store.getZones()).toEqual([]);
  });

  it("emits a change event on setPlayback", () => {
    const store = new StateStore(createInitialState());
    const listener = vi.fn();
    store.onChange(listener);

    store.setPlayback({ state: "playing", volume: 80, muted: false });

    expect(listener).toHaveBeenCalledWith({
      type: "playback",
      playback: { state: "playing", volume: 80, muted: false },
    });
  });

  it("emits a zone change on setZone and stores it", () => {
    const store = new StateStore(createInitialState());
    const listener = vi.fn();
    store.onChange(listener);

    store.setZone(zone);

    expect(store.getZone("cockpit")).toEqual(zone);
    expect(listener).toHaveBeenCalledWith({
      type: "zone",
      zoneId: "cockpit",
      zone,
    });
  });

  it("emits zoneRemoved and drops the zone", () => {
    const store = new StateStore(createInitialState());
    store.setZone(zone);
    const listener = vi.fn();
    store.onChange(listener);

    store.removeZone("cockpit");

    expect(store.getZone("cockpit")).toBeUndefined();
    expect(listener).toHaveBeenCalledWith({
      type: "zoneRemoved",
      zoneId: "cockpit",
    });
  });

  it("does not emit when removing a zone that isn't there", () => {
    const store = new StateStore(createInitialState());
    const listener = vi.fn();
    store.onChange(listener);

    store.removeZone("nonexistent");

    expect(listener).not.toHaveBeenCalled();
  });

  it("persists and restores zone assignments independent of live zone state", () => {
    const store = new StateStore(createInitialState());
    store.setZoneAssignment("cockpit", { n2kZone: 0 });

    const snapshot = store.getPersistedZoneAssignments();
    const restored = new StateStore(createInitialState());
    restored.restoreZoneAssignments(snapshot);

    expect(restored.getZoneAssignment("cockpit")).toEqual({ n2kZone: 0 });
    // Restoring assignments doesn't fabricate a live zone.
    expect(restored.getZone("cockpit")).toBeUndefined();
  });
});
