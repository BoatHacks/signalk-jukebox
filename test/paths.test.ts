import { describe, it, expect, vi } from "vitest";
import { publishStateChanges } from "../src/paths.js";
import { StateStore, createInitialState } from "../src/state/store.js";

describe("publishStateChanges", () => {
  it("sends playback meta once, immediately, before any change", () => {
    const handleMessage = vi.fn();
    const store = new StateStore(createInitialState());
    publishStateChanges({ handleMessage }, "signalk-jukebox", store);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const [pluginId, delta] = handleMessage.mock.calls[0] as [
      string,
      { updates: { meta?: { path: string; value: unknown }[] }[] },
    ];
    expect(pluginId).toBe("signalk-jukebox");
    const metaPaths = delta.updates[0]!.meta!.map((m) => m.path).sort();
    expect(metaPaths).toEqual(
      [
        "entertainment.jukebox.playback.state",
        "entertainment.jukebox.playback.volume",
        "entertainment.jukebox.playback.track",
      ].sort(),
    );
  });

  it("sends a zone's meta once, the first time it appears, alongside its values", () => {
    const handleMessage = vi.fn();
    const store = new StateStore(createInitialState());
    publishStateChanges({ handleMessage }, "signalk-jukebox", store);
    handleMessage.mockClear();

    store.setZone({
      id: "z1",
      groupId: "g1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      activeSource: "jukebox",
    });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const [, delta] = handleMessage.mock.calls[0] as [
      string,
      {
        updates: {
          values?: { path: string }[];
          meta?: { path: string }[];
        }[];
      },
    ];
    expect(delta.updates).toHaveLength(2);
    expect(delta.updates[0]!.values).toBeDefined();
    const metaPaths = delta.updates[1]!.meta!.map((m) => m.path).sort();
    expect(metaPaths).toEqual(
      [
        "entertainment.jukebox.zones.z1.connected",
        "entertainment.jukebox.zones.z1.volume",
        "entertainment.jukebox.zones.z1.muted",
        "entertainment.jukebox.zones.z1.n2kZone",
      ].sort(),
    );
  });

  it("does not resend a zone's meta on subsequent updates", () => {
    const handleMessage = vi.fn();
    const store = new StateStore(createInitialState());
    publishStateChanges({ handleMessage }, "signalk-jukebox", store);

    const zone = {
      id: "z1",
      groupId: "g1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      activeSource: "jukebox" as const,
    };
    store.setZone(zone);
    handleMessage.mockClear();
    store.setZone({ ...zone, volume: 60 });

    const [, delta] = handleMessage.mock.calls[0] as [
      string,
      { updates: unknown[] },
    ];
    expect(delta.updates).toHaveLength(1); // values only, no meta
  });

  it("publishes playback.volume as a 0-1 ratio, not the internal 0-100 value", () => {
    const handleMessage = vi.fn();
    const store = new StateStore(createInitialState());
    publishStateChanges({ handleMessage }, "signalk-jukebox", store);
    handleMessage.mockClear();

    store.setPlayback({ state: "playing", volume: 42, muted: false });

    const [, delta] = handleMessage.mock.calls[0] as [
      string,
      { updates: { values: { path: string; value: unknown }[] }[] },
    ];
    const volumeUpdate = delta.updates[0]!.values.find(
      (v) => v.path === "entertainment.jukebox.playback.volume",
    );
    expect(volumeUpdate?.value).toBeCloseTo(0.42);
  });

  it("publishes a zone's volume as a 0-1 ratio, not the internal 0-100 value", () => {
    const handleMessage = vi.fn();
    const store = new StateStore(createInitialState());
    publishStateChanges({ handleMessage }, "signalk-jukebox", store);
    handleMessage.mockClear();

    store.setZone({
      id: "z1",
      groupId: "g1",
      name: "Salon",
      connected: true,
      volume: 80,
      muted: false,
      activeSource: "jukebox",
    });

    const [, delta] = handleMessage.mock.calls[0] as [
      string,
      { updates: { values?: { path: string; value: unknown }[] }[] },
    ];
    const volumeUpdate = delta.updates[0]!.values!.find(
      (v) => v.path === "entertainment.jukebox.zones.z1.volume",
    );
    expect(volumeUpdate?.value).toBeCloseTo(0.8);
  });
});
