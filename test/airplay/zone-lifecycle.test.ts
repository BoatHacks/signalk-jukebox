import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startAirplayZoneSync } from "../../src/airplay/zone-lifecycle.js";
import type {
  SnapserverClient,
  SnapGroup,
} from "../../src/snapserver-client.js";

function fakeSnapserver(
  groups: SnapGroup[],
  streamStatuses: Record<string, string> = {},
) {
  return {
    getGroups: vi.fn().mockResolvedValue(groups),
    getStreamStatuses: vi.fn().mockResolvedValue(streamStatuses),
    addStream: vi
      .fn()
      .mockImplementation((uri: string) =>
        Promise.resolve({ streamId: new URL(uri).searchParams.get("name") }),
      ),
    removeStream: vi.fn().mockResolvedValue(undefined),
    setGroupStream: vi.fn().mockResolvedValue(undefined),
  } as unknown as SnapserverClient;
}

const fakeApp = { getSelfPath: () => "Tinarasia" };
const NAME_PATTERN = "{boatName} - {zoneName}";

describe("startAirplayZoneSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("creates an AirPlay receiver stream for a newly-seen connected zone", async () => {
    const snapserver = fakeSnapserver([
      {
        id: "group-1",
        streamId: "MusicAndAlerts",
        clients: [
          {
            id: "zone-a",
            name: "Salon",
            connected: true,
            volume: 50,
            muted: false,
            groupId: "group-1",
          },
        ],
      },
    ]);

    const stop = startAirplayZoneSync(
      snapserver,
      fakeApp,
      NAME_PATTERN,
      vi.fn(),
    );
    await vi.waitFor(() => expect(snapserver.addStream).toHaveBeenCalled());

    const uri = (snapserver.addStream as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(uri).toContain("devicename=Tinarasia+-+Salon");
    expect(uri).toContain("name=airplay-zone-a");

    stop();
  });

  it("does not recreate a stream for a zone already tracked", async () => {
    const snapserver = fakeSnapserver([
      {
        id: "group-1",
        streamId: "MusicAndAlerts",
        clients: [
          {
            id: "zone-a",
            name: "Salon",
            connected: true,
            volume: 50,
            muted: false,
            groupId: "group-1",
          },
        ],
      },
    ]);

    const stop = startAirplayZoneSync(
      snapserver,
      fakeApp,
      NAME_PATTERN,
      vi.fn(),
      1000,
    );
    await vi.waitFor(() =>
      expect(snapserver.addStream).toHaveBeenCalledTimes(1),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(snapserver.addStream).toHaveBeenCalledTimes(1);

    stop();
  });

  it("removes a zone's receiver stream once it's no longer seen", async () => {
    const groups: SnapGroup[] = [
      {
        id: "group-1",
        streamId: "MusicAndAlerts",
        clients: [
          {
            id: "zone-a",
            name: "Salon",
            connected: true,
            volume: 50,
            muted: false,
            groupId: "group-1",
          },
        ],
      },
    ];
    const snapserver = fakeSnapserver(groups);
    const getGroups = snapserver.getGroups as ReturnType<typeof vi.fn>;

    const stop = startAirplayZoneSync(
      snapserver,
      fakeApp,
      NAME_PATTERN,
      vi.fn(),
      1000,
    );
    await vi.waitFor(() =>
      expect(snapserver.addStream).toHaveBeenCalledTimes(1),
    );

    getGroups.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(snapserver.removeStream).toHaveBeenCalledWith("airplay-zone-a"),
    );

    stop();
  });

  it("switches a zone's group onto its AirPlay stream once a real session starts", async () => {
    const groups: SnapGroup[] = [
      {
        id: "group-1",
        streamId: "MusicAndAlerts",
        clients: [
          {
            id: "zone-a",
            name: "Salon",
            connected: true,
            volume: 50,
            muted: false,
            groupId: "group-1",
          },
        ],
      },
    ];
    const snapserver = fakeSnapserver(groups);
    const getStreamStatuses = snapserver.getStreamStatuses as ReturnType<
      typeof vi.fn
    >;

    const stop = startAirplayZoneSync(
      snapserver,
      fakeApp,
      NAME_PATTERN,
      vi.fn(),
      1000,
    );
    await vi.waitFor(() =>
      expect(snapserver.addStream).toHaveBeenCalledTimes(1),
    );

    getStreamStatuses.mockResolvedValue({ "airplay-zone-a": "playing" });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(snapserver.setGroupStream).toHaveBeenCalledWith(
        "group-1",
        "airplay-zone-a",
      ),
    );

    stop();
  });

  it("switches a zone back to the jukebox stream once its AirPlay session ends", async () => {
    // group already on its own AirPlay stream, matching what a real
    // Snapserver would report once a session has actually started
    const groups: SnapGroup[] = [
      {
        id: "group-1",
        streamId: "airplay-zone-a",
        clients: [
          {
            id: "zone-a",
            name: "Salon",
            connected: true,
            volume: 50,
            muted: false,
            groupId: "group-1",
          },
        ],
      },
    ];
    const snapserver = fakeSnapserver(groups, { "airplay-zone-a": "idle" });

    const stop = startAirplayZoneSync(
      snapserver,
      fakeApp,
      NAME_PATTERN,
      vi.fn(),
    );
    await vi.waitFor(() =>
      expect(snapserver.setGroupStream).toHaveBeenCalledWith(
        "group-1",
        "MusicAndAlerts",
      ),
    );

    stop();
  });

  it("disambiguates two zones that would otherwise advertise the same name", async () => {
    const groups: SnapGroup[] = [
      {
        id: "group-1",
        streamId: "MusicAndAlerts",
        clients: [
          {
            id: "zone-a",
            name: "Salon",
            connected: true,
            volume: 50,
            muted: false,
            groupId: "group-1",
          },
        ],
      },
      {
        id: "group-2",
        streamId: "MusicAndAlerts",
        clients: [
          {
            id: "zone-b",
            name: "Salon",
            connected: true,
            volume: 50,
            muted: false,
            groupId: "group-2",
          },
        ],
      },
    ];
    const snapserver = fakeSnapserver(groups);

    const stop = startAirplayZoneSync(
      snapserver,
      fakeApp,
      NAME_PATTERN,
      vi.fn(),
    );
    await vi.waitFor(() =>
      expect(snapserver.addStream).toHaveBeenCalledTimes(2),
    );

    const uris = (
      snapserver.addStream as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0] as string);
    const deviceNames = uris.map((u) =>
      new URL(u).searchParams.get("devicename"),
    );
    expect(new Set(deviceNames).size).toBe(2);
    expect(deviceNames).toContain("Tinarasia - Salon");
    expect(deviceNames).toContain("Tinarasia - Salon (zone-b)");

    stop();
  });

  it("reports a Snapserver failure via onError instead of throwing", async () => {
    const snapserver = {
      getGroups: vi.fn().mockRejectedValue(new Error("connection refused")),
      getStreamStatuses: vi.fn().mockResolvedValue({}),
      addStream: vi.fn(),
      removeStream: vi.fn(),
      setGroupStream: vi.fn(),
    } as unknown as SnapserverClient;
    const onError = vi.fn();

    const stop = startAirplayZoneSync(
      snapserver,
      fakeApp,
      NAME_PATTERN,
      onError,
    );
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining("connection refused"),
      ),
    );

    stop();
  });
});
