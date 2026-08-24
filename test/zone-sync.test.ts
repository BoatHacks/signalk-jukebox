import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  migrateZonesToCurrentJukeboxStream,
  startZoneSync,
} from "../src/zone-sync.js";
import type { SnapserverClient, SnapGroup } from "../src/snapserver-client.js";
import { StateStore, createInitialState } from "../src/state/store.js";

function fakeSnapserver(groups: SnapGroup[]) {
  return {
    getGroups: vi.fn().mockResolvedValue(groups),
    setGroupStream: vi.fn().mockResolvedValue(undefined),
  } as unknown as SnapserverClient;
}

describe("migrateZonesToCurrentJukeboxStream", () => {
  it("moves a group still on either legacy jukebox stream name onto MusicAndAlerts", async () => {
    const snapserver = fakeSnapserver([
      { id: "group-1", streamId: "Jukebox", clients: [] },
      { id: "group-2", streamId: "Output", clients: [] },
    ]);
    const onError = vi.fn();

    await migrateZonesToCurrentJukeboxStream(snapserver, onError);

    expect(snapserver.setGroupStream).toHaveBeenCalledWith("group-1", "MusicAndAlerts");
    expect(snapserver.setGroupStream).toHaveBeenCalledWith("group-2", "MusicAndAlerts");
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves a group already on MusicAndAlerts, Alerts, Silence, or its own AirPlay stream alone", async () => {
    const snapserver = fakeSnapserver([
      { id: "group-1", streamId: "MusicAndAlerts", clients: [] },
      { id: "group-2", streamId: "Alerts", clients: [] },
      { id: "group-3", streamId: "Silence", clients: [] },
      { id: "group-4", streamId: "AirPlay - Salon", clients: [] },
    ]);

    await migrateZonesToCurrentJukeboxStream(snapserver, vi.fn());

    expect(snapserver.setGroupStream).not.toHaveBeenCalled();
  });

  it("logs via the given callback rather than throwing when Snapserver is unreachable", async () => {
    const snapserver = {
      getGroups: vi.fn().mockRejectedValue(new Error("connection refused")),
      setGroupStream: vi.fn(),
    } as unknown as SnapserverClient;
    const onError = vi.fn();

    await migrateZonesToCurrentJukeboxStream(snapserver, onError);

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
  });
});

describe("startZoneSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeSnapserverWithGroups(groups: SnapGroup[]) {
    return {
      getGroups: vi.fn().mockResolvedValue(groups),
    } as unknown as SnapserverClient;
  }

  it("claims the next free n2kZone for a genuinely new zone, and fires the onZoneAssignmentClaimed callback", async () => {
    const store = new StateStore(createInitialState());
    const snapserver = fakeSnapserverWithGroups([
      { id: "group-1", streamId: "MusicAndAlerts", clients: [
        { id: "zone-a", name: "Salon", connected: true, volume: 50, muted: false, groupId: "group-1" },
      ] },
    ]);
    const onClaimed = vi.fn();

    const stop = startZoneSync(store, snapserver, 2000, onClaimed);
    await vi.waitFor(() => expect(store.getZone("zone-a")).toBeDefined());

    expect(store.getZone("zone-a")?.n2kZone).toBe(0);
    expect(store.getZoneAssignment("zone-a")?.n2kZone).toBe(0);
    expect(onClaimed).toHaveBeenCalledTimes(1);

    stop();
  });

  it("restores an existing persisted n2kZone instead of reclaiming, and does not fire onZoneAssignmentClaimed again", async () => {
    const store = new StateStore(createInitialState());
    store.restoreZoneAssignments({ "zone-a": { n2kZone: 2 } });
    const snapserver = fakeSnapserverWithGroups([
      { id: "group-1", streamId: "MusicAndAlerts", clients: [
        { id: "zone-a", name: "Salon", connected: true, volume: 50, muted: false, groupId: "group-1" },
      ] },
    ]);
    const onClaimed = vi.fn();

    const stop = startZoneSync(store, snapserver, 2000, onClaimed);
    await vi.waitFor(() => expect(store.getZone("zone-a")).toBeDefined());

    expect(store.getZone("zone-a")?.n2kZone).toBe(2);
    expect(onClaimed).not.toHaveBeenCalled();

    stop();
  });

  it("assigns increasing n2kZone numbers to distinct zones seen for the first time, in the order they're processed", async () => {
    const store = new StateStore(createInitialState());
    const snapserver = fakeSnapserverWithGroups([
      { id: "group-1", streamId: "MusicAndAlerts", clients: [
        { id: "zone-a", name: "Salon", connected: true, volume: 50, muted: false, groupId: "group-1" },
        { id: "zone-b", name: "Cockpit", connected: true, volume: 50, muted: false, groupId: "group-1" },
      ] },
    ]);

    const stop = startZoneSync(store, snapserver, 2000);
    await vi.waitFor(() => expect(store.getZone("zone-b")).toBeDefined());

    expect(store.getZone("zone-a")?.n2kZone).toBe(0);
    expect(store.getZone("zone-b")?.n2kZone).toBe(1);

    stop();
  });

  it("leaves a 5th zone without an n2kZone once the 4-zone cap is full, without erroring", async () => {
    const store = new StateStore(createInitialState());
    store.restoreZoneAssignments({
      "zone-1": { n2kZone: 0 },
      "zone-2": { n2kZone: 1 },
      "zone-3": { n2kZone: 2 },
      "zone-4": { n2kZone: 3 },
    });
    const snapserver = fakeSnapserverWithGroups([
      { id: "group-1", streamId: "MusicAndAlerts", clients: [
        { id: "zone-1", name: "Z1", connected: true, volume: 50, muted: false, groupId: "group-1" },
        { id: "zone-2", name: "Z2", connected: true, volume: 50, muted: false, groupId: "group-1" },
        { id: "zone-3", name: "Z3", connected: true, volume: 50, muted: false, groupId: "group-1" },
        { id: "zone-4", name: "Z4", connected: true, volume: 50, muted: false, groupId: "group-1" },
        { id: "zone-5", name: "Z5", connected: true, volume: 50, muted: false, groupId: "group-1" },
      ] },
    ]);
    const onClaimed = vi.fn();

    const stop = startZoneSync(store, snapserver, 2000, onClaimed);
    await vi.waitFor(() => expect(store.getZone("zone-5")).toBeDefined());

    expect(store.getZone("zone-5")?.n2kZone).toBeUndefined();
    expect(onClaimed).not.toHaveBeenCalled();

    stop();
  });
});
