import { describe, it, expect, vi } from "vitest";
import { migrateZonesToCurrentJukeboxStream } from "../src/zone-sync.js";
import type { SnapserverClient, SnapGroup } from "../src/snapserver-client.js";

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
