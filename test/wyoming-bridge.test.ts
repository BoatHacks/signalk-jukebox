import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildWyomingBridgeConfig,
  renameWyomingBridgeZone,
  wyomingBridgeContainerName,
  orphanedWyomingBridgeIds,
  WYOMING_BRIDGE_IMAGE,
  type RenameableSnapserverClient,
} from "../src/wyoming-bridge.js";
import { SK_HOST_ALIAS } from "../src/local-snapclient.js";

describe("buildWyomingBridgeConfig", () => {
  it("points at the host-gateway alias, not a literal address", () => {
    const config = buildWyomingBridgeConfig("auto", {
      id: "salon-panel",
      enabled: true,
      zoneName: "Salon Panel",
      satelliteHost: "192.168.1.50",
      satellitePort: 10700,
      tag: "auto",
    });
    expect(config.image).toBe(WYOMING_BRIDGE_IMAGE);
    expect(config.env?.SNAPCAST_HOST).toBe(SK_HOST_ALIAS);
    expect(config.env?.SNAPCAST_PORT).toBe("1704");
    expect(config.env?.SNAPCAST_CONTROL_PORT).toBe("1705");
    expect(config.extraHosts).toEqual({ [SK_HOST_ALIAS]: "host-gateway" });
  });

  it("forwards the satellite target and bridge id verbatim", () => {
    const config = buildWyomingBridgeConfig("auto", {
      id: "v-berth-panel",
      enabled: true,
      zoneName: "V-Berth Panel",
      satelliteHost: "10.42.23.95",
      satellitePort: 10701,
      tag: "auto",
    });
    expect(config.env?.WYOMING_HOST).toBe("10.42.23.95");
    expect(config.env?.WYOMING_PORT).toBe("10701");
    expect(config.env?.BRIDGE_ID).toBe("v-berth-panel");
  });

  it("does not request audio-device passthrough (no hardware of its own)", () => {
    const config = buildWyomingBridgeConfig("auto", {
      id: "salon-panel",
      enabled: true,
      zoneName: "Salon Panel",
      satelliteHost: "192.168.1.50",
      satellitePort: 10700,
      tag: "auto",
    }) as { devices?: string[]; groupAdd?: string[] };
    expect(config.devices).toBeUndefined();
    expect(config.groupAdd).toBeUndefined();
  });
});

describe("wyomingBridgeContainerName", () => {
  it("derives a distinct container name per bridge id", () => {
    expect(wyomingBridgeContainerName("salon-panel")).toBe(
      "wyoming-bridge-salon-panel",
    );
    expect(wyomingBridgeContainerName("v-berth-panel")).toBe(
      "wyoming-bridge-v-berth-panel",
    );
  });
});

describe("orphanedWyomingBridgeIds", () => {
  it("flags an id whose entry was removed from settings entirely", () => {
    const orphans = orphanedWyomingBridgeIds(
      ["salon-panel", "v-berth-panel"], // previously known (persisted last start)
      ["salon-panel"], // v-berth-panel's entry no longer exists
    );
    expect(orphans).toEqual(["v-berth-panel"]);
  });

  it("flags an id whose entry is still present but disabled", () => {
    // enabledEntryIds is the caller's pre-filtered list (index.ts filters
    // by entry.enabled before calling this) -- an id absent here because
    // it's disabled looks identical to one absent because it was deleted,
    // and should be treated the same way.
    const orphans = orphanedWyomingBridgeIds(
      ["salon-panel"],
      [], // salon-panel's entry exists but enabled: false
    );
    expect(orphans).toEqual(["salon-panel"]);
  });

  it("leaves a still-wanted id alone", () => {
    const orphans = orphanedWyomingBridgeIds(["salon-panel"], ["salon-panel"]);
    expect(orphans).toEqual([]);
  });

  it("flags nothing the first time (no previously-known ids yet)", () => {
    const orphans = orphanedWyomingBridgeIds([], ["salon-panel"]);
    expect(orphans).toEqual([]);
  });
});

describe("renameWyomingBridgeZone", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sets the name as soon as the known client id appears", async () => {
    const setClientName = vi.fn().mockResolvedValue(undefined);
    const snapserver: RenameableSnapserverClient = {
      getGroups: vi
        .fn()
        .mockResolvedValue([{ clients: [{ id: "salon-panel" }] }]),
      setClientName,
    };

    renameWyomingBridgeZone(snapserver, "salon-panel", "Salon Panel");
    await vi.waitFor(() =>
      expect(setClientName).toHaveBeenCalledWith("salon-panel", "Salon Panel"),
    );
  });

  it("tracks each bridge id independently", async () => {
    // Two bridges polling concurrently must never rename the wrong one --
    // this is the whole reason the client id is a parameter here instead
    // of a single fixed constant like local-snapclient.ts's.
    const setClientName = vi.fn().mockResolvedValue(undefined);
    const snapserver: RenameableSnapserverClient = {
      getGroups: vi
        .fn()
        .mockResolvedValue([
          { clients: [{ id: "salon-panel" }, { id: "v-berth-panel" }] },
        ]),
      setClientName,
    };

    renameWyomingBridgeZone(snapserver, "salon-panel", "Salon Panel");
    renameWyomingBridgeZone(snapserver, "v-berth-panel", "V-Berth Panel");
    await vi.waitFor(() => {
      expect(setClientName).toHaveBeenCalledWith("salon-panel", "Salon Panel");
      expect(setClientName).toHaveBeenCalledWith(
        "v-berth-panel",
        "V-Berth Panel",
      );
    });
    expect(setClientName).toHaveBeenCalledTimes(2);
  });

  it("retries until the client appears, then stops polling", async () => {
    const setClientName = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    const getGroups = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call < 3 ? [] : [{ clients: [{ id: "salon-panel" }] }],
      );
    });
    renameWyomingBridgeZone(
      { getGroups, setClientName },
      "salon-panel",
      "Salon Panel",
      { intervalMs: 10 },
    );

    await vi.advanceTimersByTimeAsync(10 * 10);
    expect(setClientName).toHaveBeenCalledTimes(1);
    expect(setClientName).toHaveBeenCalledWith("salon-panel", "Salon Panel");
    expect(getGroups.mock.calls.length).toBeGreaterThanOrEqual(3);

    const callsAfterFound = getGroups.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(callsAfterFound);
    expect(setClientName).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts without ever finding the client", async () => {
    const getGroups = vi.fn().mockResolvedValue([]);
    const setClientName = vi.fn();
    renameWyomingBridgeZone(
      { getGroups, setClientName },
      "salon-panel",
      "Salon Panel",
      { intervalMs: 10, maxAttempts: 3 },
    );

    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(3);
    expect(setClientName).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(3);
  });

  it("stop() cancels any pending retry", async () => {
    const getGroups = vi.fn().mockResolvedValue([]);
    const setClientName = vi.fn();
    const stop = renameWyomingBridgeZone(
      { getGroups, setClientName },
      "salon-panel",
      "Salon Panel",
      { intervalMs: 10 },
    );

    await vi.advanceTimersByTimeAsync(10 * 3);
    stop();
    const callsAtStop = getGroups.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(callsAtStop);
    expect(setClientName).not.toHaveBeenCalled();
  });
});
