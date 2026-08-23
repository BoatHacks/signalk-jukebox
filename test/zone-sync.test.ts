import { describe, it, expect, vi } from "vitest";
import { migrateZonesToOutputStream } from "../src/zone-sync.js";
import type { SnapserverClient, SnapGroup } from "../src/snapserver-client.js";

function fakeSnapserver(groups: SnapGroup[]) {
  return {
    getGroups: vi.fn().mockResolvedValue(groups),
    setGroupStream: vi.fn().mockResolvedValue(undefined),
  } as unknown as SnapserverClient;
}

describe("migrateZonesToOutputStream", () => {
  it("moves a group still on the raw Jukebox stream onto Output", async () => {
    const snapserver = fakeSnapserver([
      { id: "group-1", streamId: "Jukebox", clients: [] },
    ]);
    const onError = vi.fn();

    await migrateZonesToOutputStream(snapserver, onError);

    expect(snapserver.setGroupStream).toHaveBeenCalledWith("group-1", "Output");
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves a group already on Output, Alerts, or its own AirPlay stream alone", async () => {
    const snapserver = fakeSnapserver([
      { id: "group-1", streamId: "Output", clients: [] },
      { id: "group-2", streamId: "Alerts", clients: [] },
      { id: "group-3", streamId: "AirPlay - Salon", clients: [] },
    ]);

    await migrateZonesToOutputStream(snapserver, vi.fn());

    expect(snapserver.setGroupStream).not.toHaveBeenCalled();
  });

  it("logs via the given callback rather than throwing when Snapserver is unreachable", async () => {
    const snapserver = {
      getGroups: vi.fn().mockRejectedValue(new Error("connection refused")),
      setGroupStream: vi.fn(),
    } as unknown as SnapserverClient;
    const onError = vi.fn();

    await migrateZonesToOutputStream(snapserver, onError);

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
  });
});
