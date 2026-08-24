// Fusion-Link PGN encode/decode (SPEC.md §6.3, ARCHITECTURE.md §2.3).
//
// Scope, confirmed deliberate after research (SPEC.md §1.4, §12, §13): this
// module broadcasts under SignalK's own already-claimed N2K address via
// app.emit('nmea2000JsonOut', ...) -- it does NOT perform ISO Address Claim
// (PGN 60928) or answer Product Information (PGN 126996) as a distinct bus
// device. Whether Fusion-Link-aware MFDs still act on these broadcasts
// without that self-identification is unverified against real hardware;
// treat this module as unproven until tested (SPEC.md §13).
//
// PGN classes/field names below are all read directly off @canboat/ts-pgns
// v1.11.18's own shipped .d.ts (SPEC.md §5) -- not guessed or recalled from
// memory. The exact wiring pattern (app.on('N2KAnalyzerOut', ...) for
// inbound already-decoded PGN objects, PGN_XXX.isMatch(msg) to identify
// which Fusion sub-message a raw 126720/130820 decodes to, app.emit(
// 'nmea2000JsonOut', convertCamelCase(app, pgnInstance)) for outbound)
// is confirmed against sbender9/signalk-fusion-stereo's own real,
// published source -- the actual reference plugin SPEC.md §5 cites for
// this field layout, not an invented convention.
//
// PGN 126720 carries Fusion's proprietary COMMAND messages (what an MFD,
// acting as controller, sends TO a stereo); PGN 130820 carries its
// proprietary STATUS messages (what a stereo broadcasts OUT). This plugin
// emulates the stereo, so its own traffic is the mirror image of
// signalk-fusion-stereo's (which controls a real one): outbound = 130820
// status, inbound = 126720 commands.

import {
  PGN_130820_FusionSource,
  PGN_130820_FusionTrackName,
  PGN_130820_FusionArtistName,
  PGN_130820_FusionAlbumName,
  PGN_130820_FusionVolumes,
  PGN_130820_FusionZoneName,
  PGN_130820_FusionMute,
  PGN_126720_FusionMediaControl,
  PGN_126720_FusionSetZoneVolume,
  PGN_126720_FusionSetAllVolumes,
  PGN_126720_FusionSetMute,
  PGN_126720_FusionRequestStatus,
  FusionCommand,
  FusionMuteCommand,
  convertCamelCase,
} from "@canboat/ts-pgns";

import type { PlaybackState, Zone } from "../types.js";

// Broadcast destination for a status message with no specific addressee
// (every N2K device on the bus) -- standard convention, matching how a
// real Fusion stereo broadcasts its own status.
const BROADCAST_DST = 255;

// This plugin presents exactly one virtual source (SPEC.md §6.3, §12) --
// Mopidy's own backend selection (local/radio/Spotify) is a browsing
// concept the webapp/Iris already own, not a Fusion "flip to AM/FM/Aux"
// concept. sourceId 0 is arbitrary but fixed, since Fusion-Link keys
// now-playing/source fields by sourceId, never by name.
const SOURCE_ID = 0;
const SOURCE_NAME = "Jukebox";

const AIRPLAY_PLACEHOLDER_TRACK = "AirPlay Active";

/** How often index.ts re-broadcasts current state even with nothing
 * changed (SPEC.md §6.3: "so a device joining the bus mid-session still
 * gets current state without waiting for the next change") -- on top of,
 * not instead of, the on-change broadcast and the immediate response to a
 * decoded "requestStatus" command. Not protocol-mandated, just a
 * reasonable steady-state refresh cadence. */
export const FUSION_REFRESH_INTERVAL_MS = 10_000;

export interface FusionAppLike {
  emit(event: "nmea2000JsonOut", payload: unknown): void;
  emit(event: string, payload?: unknown): void;
  /** convertCamelCase() (@canboat/ts-pgns) reads config.version to decide
   * whether the connected SignalK server is new enough to accept a PGN's
   * field names as-is (>=2.15.0) or needs them converted to the
   * library's older Title-Case convention -- confirmed by reading that
   * function's own source, not guessed; every real SignalK app object
   * has this (ships-bells' own index.js already reads
   * app.config.settings.port elsewhere in this org's plugins). */
  config: { version: string };
  on?(event: "N2KAnalyzerOut", callback: (pgn: unknown) => void): void;
  /** For plugin.stop()'s cleanup -- there's no unregisterPutHandler
   * equivalent gap here the way put-handlers.ts has to work around;
   * app.on('N2KAnalyzerOut', ...) is a plain Node EventEmitter
   * subscription, so removing it on stop is both possible and expected. */
  off?(event: "N2KAnalyzerOut", callback: (pgn: unknown) => void): void;
  debug?(msg: string): void;
}

export interface FusionAdapterOptions {
  deviceName: string;
  app: FusionAppLike;
}

/** What an incoming Fusion PGN 126720 command decodes to, already
 * translated into the same shape/vocabulary the REST and webapp write
 * paths use (SPEC.md §6.3: "every accepted command is applied to
 * canonical state via the same path a REST/web write would take -- an
 * MFD is not a second-class caller") -- callers dispatch these the exact
 * same way they'd dispatch a PLAYBACK_CONTROL_PATHS press (controls.ts)
 * or a zone volume PUT (put-handlers.ts), not through a separate N2K-only
 * code path.
 *
 * PGN_126720_FusionSetSource/FusionSetPower/FusionRequestStatus are
 * deliberately NOT modeled as actionable commands here (beyond
 * "requestStatus", below) -- SetSource has nothing to do in a
 * single-virtual-source model, and this plugin has no "power" concept of
 * its own (the container is either running or it isn't). */
export type FusionIncomingCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "zoneVolume"; n2kZone: number; volume: number }
  | { type: "masterMute"; muted: boolean }
  /** A real MFD sends PGN_126720_FusionRequestStatus when it wants a
   * fresh snapshot (typically on joining the bus) -- decoding this lets
   * the caller respond with an immediate broadcastState() call, so a
   * newly-joined device doesn't have to wait for the next periodic
   * refresh (SPEC.md §6.3's own stated goal for the refresh interval,
   * served more directly here). */
  | { type: "requestStatus" };

function resolveDisplayedTrack(
  playback: PlaybackState,
  n2kZones: Zone[],
): { title: string; artist?: string; album?: string } {
  // SPEC.md §6.3: Fusion-Link's now-playing fields are device-wide, keyed
  // by sourceId, never by zone -- there is no per-zone track message. If
  // any N2K-zoned zone is actually playing someone's AirPlay session
  // rather than the jukebox, broadcasting Mopidy's own track would show
  // something flatly false, so that zone's real track wins instead.
  // Tie-break for more than one simultaneous AirPlay zone: lowest n2kZone
  // number (deterministic, consistent with zone numbering being the
  // stable identity used throughout this plugin).
  const airplayZones = n2kZones
    .filter((z) => z.activeSource === "airplay")
    .sort((a, b) => (a.n2kZone ?? 0) - (b.n2kZone ?? 0));

  const lowestAirplayZone = airplayZones[0];
  if (lowestAirplayZone) {
    const track = lowestAirplayZone.airplay?.track;
    return track
      ? { title: track.title, artist: track.artist, album: track.album }
      : { title: AIRPLAY_PLACEHOLDER_TRACK };
  }

  return {
    title: playback.track?.name || "",
    artist: playback.track?.artist,
    album: playback.track?.album,
  };
}

export class FusionAdapter {
  constructor(private readonly opts: FusionAdapterOptions) {}

  private send(pgn: { getDefinition?: () => unknown }): void {
    this.opts.app.emit(
      "nmea2000JsonOut",
      convertCamelCase(this.opts.app, pgn as never),
    );
  }

  /** Broadcast current playback/zone state as Fusion PGN 130820 status
   * messages (SPEC.md §6.3). Called on every canonical-state change, plus
   * on a periodic refresh interval and in response to a decoded
   * "requestStatus" command, so a device joining the bus mid-session
   * still gets current state without waiting for the next change. */
  broadcastState(playback: PlaybackState, zones: Zone[]): void {
    const n2kZones = zones
      .filter((z): z is Zone & { n2kZone: number } => z.n2kZone !== undefined)
      .sort((a, b) => a.n2kZone - b.n2kZone);

    this.send(
      new PGN_130820_FusionSource(
        {
          sourceId: SOURCE_ID,
          currentSourceId: SOURCE_ID,
          source: this.opts.deviceName || SOURCE_NAME,
        },
        BROADCAST_DST,
      ),
    );

    const track = resolveDisplayedTrack(playback, n2kZones);
    this.send(
      new PGN_130820_FusionTrackName(
        { sourceId: SOURCE_ID, track: track.title },
        BROADCAST_DST,
      ),
    );
    if (track.artist !== undefined) {
      this.send(
        new PGN_130820_FusionArtistName(
          { sourceId: SOURCE_ID, artist: track.artist },
          BROADCAST_DST,
        ),
      );
    }
    if (track.album !== undefined) {
      this.send(
        new PGN_130820_FusionAlbumName(
          { sourceId: SOURCE_ID, album: track.album },
          BROADCAST_DST,
        ),
      );
    }

    this.send(
      new PGN_130820_FusionMute(
        { mute: playback.muted ? FusionMuteCommand.MuteOn : FusionMuteCommand.MuteOff },
        BROADCAST_DST,
      ),
    );

    if (n2kZones.length > 0) {
      const byZone = new Map(n2kZones.map((z) => [z.n2kZone, z]));
      this.send(
        new PGN_130820_FusionVolumes(
          {
            zone1: byZone.get(0)?.volume,
            zone2: byZone.get(1)?.volume,
            zone3: byZone.get(2)?.volume,
            zone4: byZone.get(3)?.volume,
          },
          BROADCAST_DST,
        ),
      );
      for (const zone of n2kZones) {
        this.send(
          new PGN_130820_FusionZoneName(
            { number: zone.n2kZone, name: zone.name },
            BROADCAST_DST,
          ),
        );
      }
    }
  }

  /** Decode an incoming Fusion PGN 126720 command into zero or more
   * canonical-state commands (SPEC.md §6.3) -- zero for a message this
   * plugin doesn't act on (see FusionIncomingCommand's own doc comment),
   * more than one only for FusionSetAllVolumes (one message setting up
   * to four zones' volume at once). Not a Fusion PGN at all (any other
   * manufacturer's proprietary message, or a standard PGN) also decodes
   * to an empty array, silently -- N2KAnalyzerOut fires for every PGN on
   * the bus, not just Fusion ones. */
  decodeIncoming(pgn: unknown): FusionIncomingCommand[] {
    if (PGN_126720_FusionMediaControl.isMatch(pgn as never)) {
      const command = (pgn as PGN_126720_FusionMediaControl).fields.command;
      switch (command) {
        case FusionCommand.Play:
          return [{ type: "play" }];
        case FusionCommand.Pause:
          return [{ type: "pause" }];
        case FusionCommand.Next:
          return [{ type: "next" }];
        case FusionCommand.Prev:
          return [{ type: "previous" }];
        default:
          return [];
      }
    }

    if (PGN_126720_FusionSetZoneVolume.isMatch(pgn as never)) {
      const fields = (pgn as PGN_126720_FusionSetZoneVolume).fields;
      if (fields.zone === undefined || fields.volume === undefined) return [];
      return [{ type: "zoneVolume", n2kZone: fields.zone, volume: fields.volume }];
    }

    if (PGN_126720_FusionSetAllVolumes.isMatch(pgn as never)) {
      const fields = (pgn as PGN_126720_FusionSetAllVolumes).fields;
      const commands: FusionIncomingCommand[] = [];
      const zoneVolumes: [number, number | undefined][] = [
        [0, fields.zone1],
        [1, fields.zone2],
        [2, fields.zone3],
        [3, fields.zone4],
      ];
      for (const [n2kZone, volume] of zoneVolumes) {
        if (volume !== undefined) {
          commands.push({ type: "zoneVolume", n2kZone, volume });
        }
      }
      return commands;
    }

    if (PGN_126720_FusionSetMute.isMatch(pgn as never)) {
      const command = (pgn as PGN_126720_FusionSetMute).fields.command;
      if (command === FusionMuteCommand.MuteOn) return [{ type: "masterMute", muted: true }];
      if (command === FusionMuteCommand.MuteOff) return [{ type: "masterMute", muted: false }];
      return [];
    }

    if (PGN_126720_FusionRequestStatus.isMatch(pgn as never)) {
      return [{ type: "requestStatus" }];
    }

    return [];
  }
}
