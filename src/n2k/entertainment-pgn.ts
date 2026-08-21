// Standard NMEA2000 Entertainment PGN encode/decode (SPEC.md §6.3,
// secondary surface). Coverage among real chartplotters is unverified
// (SPEC.md §13) -- if testing shows effectively no devices implement this
// set, ARCHITECTURE.md §9 notes this file can be dropped entirely without
// affecting Fusion-Link (fusion.ts), since both sit behind the same
// adapter boundary.
//
// TODO(implementation): stub. No PGN encoding exists yet.

import type { PlaybackState, Zone } from "../types.js";

export class EntertainmentPgnAdapter {
  constructor(private readonly emitNmea2000: (pgn: string) => void) {}

  broadcastState(_playback: PlaybackState, _zones: Zone[]): void {
    void this.emitNmea2000;
  }
}
