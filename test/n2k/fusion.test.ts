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

interface EmittedPgn {
  fields: Record<string, unknown>;
}

// A real, modern-version app object -- confirmed by reading
// convertCamelCase's own source that it reads config.version to decide
// whether to pass a PGN's fields through unchanged (>=2.15.0) or convert
// them; every test app here is "new enough", so emit() always receives
// the constructed PGN instance itself, unmodified.
function fakeApp() {
  const emit = vi.fn<(event: string, payload?: unknown) => void>();
  const app: FusionAppLike = {
    config: { version: "2.20.0" },
    emit,
  };
  return { app, emit };
}

function emittedPgns(emit: ReturnType<typeof vi.fn>): EmittedPgn[] {
  return emit.mock.calls.map((call) => call[1] as EmittedPgn);
}

function pgnsOfType<T extends EmittedPgn>(
  emit: ReturnType<typeof vi.fn>,
  ctor: { isMatch: (pgn: never) => boolean },
): T[] {
  return emittedPgns(emit).filter((pgn) => ctor.isMatch(pgn as never)) as T[];
}

/** The first emitted PGN whose `fields` object has the given key set --
 * throws (failing the test with a clear message) rather than returning
 * undefined, so every caller gets a real, non-optional EmittedPgn back. */
function firstWithField(emit: ReturnType<typeof vi.fn>, field: string): EmittedPgn {
  const found = emittedPgns(emit).find((pgn) => pgn.fields[field] !== undefined);
  if (!found) throw new Error(`no emitted PGN had a "${field}" field`);
  return found;
}

function allWithField(emit: ReturnType<typeof vi.fn>, field: string): EmittedPgn[] {
  return emittedPgns(emit).filter((pgn) => pgn.fields[field] !== undefined);
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
    const { app, emit } = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    adapter.broadcastState(basePlayback, [makeZone({ n2kZone: 0 })]);

    const sourcePgns = pgnsOfType<EmittedPgn>(emit, PGN_130820_FusionSource);
    expect(sourcePgns).toHaveLength(1);
    expect(sourcePgns[0]?.fields.source).toBe("Jukebox");

    expect(firstWithField(emit, "track").fields.track).toBe("Groove Salad");
    expect(firstWithField(emit, "artist").fields.artist).toBe("SomaFM");
  });

  it("broadcasts the lowest-n2kZone AirPlay zone's real track instead of Mopidy's, when one zone is on AirPlay", () => {
    const { app, emit } = fakeApp();
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

    expect(firstWithField(emit, "track").fields.track).toBe("AirPlay Song");
  });

  it("falls back to the AirPlay placeholder when the AirPlay zone has no metadata yet", () => {
    const { app, emit } = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    const zones = [makeZone({ n2kZone: 0, activeSource: "airplay", airplay: { streamName: "s", connected: true } })];

    adapter.broadcastState(basePlayback, zones);

    expect(firstWithField(emit, "track").fields.track).toBe("AirPlay Active");
  });

  it("tie-breaks two simultaneous AirPlay zones by the lowest n2kZone", () => {
    const { app, emit } = fakeApp();
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

    expect(firstWithField(emit, "track").fields.track).toBe("Should Win");
  });

  it("reflects master mute state", () => {
    const { app, emit } = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    adapter.broadcastState({ ...basePlayback, muted: true }, []);

    expect(firstWithField(emit, "mute").fields.mute).toBe(FusionMuteCommand.MuteOn);
  });

  it("broadcasts per-zone volumes/names only for zones with an n2kZone, mapped by slot", () => {
    const { app, emit } = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    const zones = [
      makeZone({ id: "z0", n2kZone: 0, volume: 10, name: "Salon" }),
      makeZone({ id: "z2", n2kZone: 2, volume: 30, name: "Cockpit" }),
      makeZone({ id: "z-no-slot", volume: 99, name: "Unassigned" }),
    ];

    adapter.broadcastState(basePlayback, zones);

    const volumeCalls = emittedPgns(emit).filter(
      (pgn) => pgn.fields.zone1 !== undefined || pgn.fields.zone2 !== undefined || pgn.fields.zone3 !== undefined,
    );
    expect(volumeCalls).toHaveLength(1);
    const volumes = volumeCalls[0];
    if (!volumes) throw new Error("expected a volumes PGN");
    expect(volumes.fields.zone1).toBe(10);
    expect(volumes.fields.zone2).toBeUndefined();
    expect(volumes.fields.zone3).toBe(30);
    expect(volumes.fields.zone4).toBeUndefined();

    const zoneNameCalls = allWithField(emit, "number");
    const names = zoneNameCalls.map((pgn) => [pgn.fields.number, pgn.fields.name]);
    expect(names).toContainEqual([0, "Salon"]);
    expect(names).toContainEqual([2, "Cockpit"]);
    expect(names).not.toContainEqual([undefined, "Unassigned"]);
  });

  it("skips volume/zone-name broadcasts entirely when no zone has an n2kZone", () => {
    const { app, emit } = fakeApp();
    const adapter = new FusionAdapter({ deviceName: "Jukebox", app });

    adapter.broadcastState(basePlayback, [makeZone({ n2kZone: undefined })]);

    expect(allWithField(emit, "zone1")).toHaveLength(0);
  });
});

describe("FusionAdapter.decodeIncoming", () => {
  const { app } = fakeApp();
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
