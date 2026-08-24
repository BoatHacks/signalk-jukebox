import { describe, it, expect, vi } from "vitest";
import {
  FusionAdapter,
  type FusionAppLike,
  type FusionIncomingCommand,
} from "../../src/n2k/fusion.js";
import {
  PGN_126720_FusionMediaControl,
  PGN_126720_FusionSetZoneVolume,
  PGN_126720_FusionSetAllVolumes,
  PGN_126720_FusionSetMute,
  PGN_126720_FusionSetSource,
  PGN_126720_FusionRequestStatus,
  PGN_130820_FusionSource,
  FusionCommand,
  FusionMuteCommand,
} from "@canboat/ts-pgns";
import type { PlaybackState, Zone } from "../../src/types.js";

// A real, modern-version app object -- confirmed by reading
// convertCamelCase's own source that it reads config.version to decide
// whether to pass a PGN's fields through unchanged (>=2.15.0) or convert
// them; every test app here is "new enough", so emit() always receives
// the constructed PGN instance itself, unmodified.
function fakeApp(): FusionAppLike & { emit: ReturnType<typeof vi.fn> } {
  return {
    config: { version: "2.20.0" },
    emit: vi.fn(),
  };
}

function pgnsOfType<T>(
  emit: ReturnType<typeof vi.fn>,
  ctor: { isMatch: (pgn: unknown) => boolean },
): T[] {
  return emit.mock.calls
    .map((call) => call[1])
    .filter((pgn): pgn is T => ctor.isMatch(pgn));
}

const basePlayback: PlaybackState = {
  state: "playing",
  volume: 50,
  muted: false,
  track: { uri: "local:track:1", name: "Groove Salad", artist: "SomaFM", album: "Ambient" },
};

function makeZone(overrides: Partial<Zone> = {}): Zone {
  return {
    id: "zone-a",
    groupId: "group-1",
    name: "Salon",
    connected: true,
    volume: 50,
    muted: false,
    activeSource: "jukebox",
    ...overrides,
  };
}

describe("FusionAdapter.broadcastState", () => {
  it("always broadcasts source and Mopidy's own track when no zone is on AirPlay", () => {
    const app = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    adapter.broadcastState(basePlayback, [makeZone({ n2kZone: 0 })]);

    const sourcePgns = pgnsOfType<PGN_130820_FusionSource>(app.emit, PGN_130820_FusionSource);
    expect(sourcePgns).toHaveLength(1);
    expect(sourcePgns[0].fields.source).toBe("Jukebox");

    const trackCalls = app.emit.mock.calls.filter(
      (c) => c[1]?.fields?.track !== undefined,
    );
    expect(trackCalls[0][1].fields.track).toBe("Groove Salad");
    const artistCalls = app.emit.mock.calls.filter(
      (c) => c[1]?.fields?.artist !== undefined,
    );
    expect(artistCalls[0][1].fields.artist).toBe("SomaFM");
  });

  it("broadcasts the lowest-n2kZone AirPlay zone's real track instead of Mopidy's, when one zone is on AirPlay", () => {
    const app = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    const zones = [
      makeZone({
        id: "zone-a",
        n2kZone: 1,
        activeSource: "airplay",
        airplay: { streamName: "s", connected: true, track: { title: "AirPlay Song", artist: "Some Artist" } },
      }),
    ];

    adapter.broadcastState(basePlayback, zones);

    const trackCalls = app.emit.mock.calls.filter((c) => c[1]?.fields?.track !== undefined);
    expect(trackCalls[0][1].fields.track).toBe("AirPlay Song");
  });

  it("falls back to the AirPlay placeholder when the AirPlay zone has no metadata yet", () => {
    const app = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    const zones = [makeZone({ n2kZone: 0, activeSource: "airplay", airplay: { streamName: "s", connected: true } })];

    adapter.broadcastState(basePlayback, zones);

    const trackCalls = app.emit.mock.calls.filter((c) => c[1]?.fields?.track !== undefined);
    expect(trackCalls[0][1].fields.track).toBe("AirPlay Active");
  });

  it("tie-breaks two simultaneous AirPlay zones by the lowest n2kZone", () => {
    const app = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    const zones = [
      makeZone({
        id: "zone-high",
        n2kZone: 3,
        activeSource: "airplay",
        airplay: { streamName: "s", connected: true, track: { title: "Should Lose" } },
      }),
      makeZone({
        id: "zone-low",
        n2kZone: 0,
        activeSource: "airplay",
        airplay: { streamName: "s", connected: true, track: { title: "Should Win" } },
      }),
    ];

    adapter.broadcastState(basePlayback, zones);

    const trackCalls = app.emit.mock.calls.filter((c) => c[1]?.fields?.track !== undefined);
    expect(trackCalls[0][1].fields.track).toBe("Should Win");
  });

  it("reflects master mute state", () => {
    const app = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    adapter.broadcastState({ ...basePlayback, muted: true }, []);

    const muteCalls = app.emit.mock.calls.filter((c) => c[1]?.fields?.mute !== undefined);
    expect(muteCalls[0][1].fields.mute).toBe(FusionMuteCommand.MuteOn);
  });

  it("broadcasts per-zone volumes/names only for zones with an n2kZone, mapped by slot", () => {
    const app = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    const zones = [
      makeZone({ id: "z0", n2kZone: 0, volume: 10, name: "Salon" }),
      makeZone({ id: "z2", n2kZone: 2, volume: 30, name: "Cockpit" }),
      makeZone({ id: "z-no-slot", volume: 99, name: "Unassigned" }),
    ];

    adapter.broadcastState(basePlayback, zones);

    const volumeCalls = app.emit.mock.calls.filter((c) => c[1]?.fields?.zone1 !== undefined || c[1]?.fields?.zone2 !== undefined || c[1]?.fields?.zone3 !== undefined);
    expect(volumeCalls).toHaveLength(1);
    expect(volumeCalls[0][1].fields.zone1).toBe(10);
    expect(volumeCalls[0][1].fields.zone2).toBeUndefined();
    expect(volumeCalls[0][1].fields.zone3).toBe(30);
    expect(volumeCalls[0][1].fields.zone4).toBeUndefined();

    const zoneNameCalls = app.emit.mock.calls.filter((c) => c[1]?.fields?.number !== undefined);
    const names = zoneNameCalls.map((c) => [c[1].fields.number, c[1].fields.name]);
    expect(names).toContainEqual([0, "Salon"]);
    expect(names).toContainEqual([2, "Cockpit"]);
    expect(names).not.toContainEqual([undefined, "Unassigned"]);
  });

  it("skips volume/zone-name broadcasts entirely when no zone has an n2kZone", () => {
    const app = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    adapter.broadcastState(basePlayback, [makeZone({ n2kZone: undefined })]);

    const volumeCalls = app.emit.mock.calls.filter((c) => c[1]?.fields?.zone1 !== undefined);
    expect(volumeCalls).toHaveLength(0);
  });
});

describe("FusionAdapter.decodeIncoming", () => {
  const app = fakeApp();
  const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

  it.each([
    [FusionCommand.Play, "play"],
    [FusionCommand.Pause, "pause"],
    [FusionCommand.Next, "next"],
    [FusionCommand.Prev, "previous"],
  ] as const)("decodes MediaControl(%s) to %s", (command, expected) => {
    const pgn = new PGN_126720_FusionMediaControl({ command, sourceId: 0 }, 255);
    expect(adapter.decodeIncoming(pgn)).toEqual([{ type: expected }]);
  });

  it("decodes SetZoneVolume into a single zoneVolume command", () => {
    const pgn = new PGN_126720_FusionSetZoneVolume({ zone: 2, volume: 65 }, 255);
    const result: FusionIncomingCommand[] = adapter.decodeIncoming(pgn);
    expect(result).toEqual([{ type: "zoneVolume", n2kZone: 2, volume: 65 }]);
  });

  it("decodes SetAllVolumes into one zoneVolume command per defined zone, skipping undefined ones", () => {
    const pgn = new PGN_126720_FusionSetAllVolumes({ zone1: 10, zone3: 30 }, 255);
    const result = adapter.decodeIncoming(pgn);
    expect(result).toEqual([
      { type: "zoneVolume", n2kZone: 0, volume: 10 },
      { type: "zoneVolume", n2kZone: 2, volume: 30 },
    ]);
  });

  it("decodes SetMute on/off into masterMute", () => {
    const on = new PGN_126720_FusionSetMute({ command: FusionMuteCommand.MuteOn }, 255);
    const off = new PGN_126720_FusionSetMute({ command: FusionMuteCommand.MuteOff }, 255);
    expect(adapter.decodeIncoming(on)).toEqual([{ type: "masterMute", muted: true }]);
    expect(adapter.decodeIncoming(off)).toEqual([{ type: "masterMute", muted: false }]);
  });

  it("decodes RequestStatus into requestStatus", () => {
    const pgn = new PGN_126720_FusionRequestStatus({}, 255);
    expect(adapter.decodeIncoming(pgn)).toEqual([{ type: "requestStatus" }]);
  });

  it("decodes SetSource (single-virtual-source model) to no actionable command", () => {
    const pgn = new PGN_126720_FusionSetSource({ sourceId: 0 }, 255);
    expect(adapter.decodeIncoming(pgn)).toEqual([]);
  });

  it("decodes an unrelated PGN (not Fusion at all) to no actionable command", () => {
    expect(adapter.decodeIncoming({ pgn: 129025, fields: {} })).toEqual([]);
  });
});
