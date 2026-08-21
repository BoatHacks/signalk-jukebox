// Fusion-Link PGN encode/decode (SPEC.md §6.3, ARCHITECTURE.md §2.3).
//
// Scope, confirmed deliberate after research (SPEC.md §1.4, §12, §13): this
// module broadcasts under SignalK's own already-claimed N2K address via
// app.emit('nmea2000out', ...) -- it does NOT perform ISO Address Claim
// (PGN 60928) or answer Product Information (PGN 126996) as a distinct bus
// device. Whether Fusion-Link-aware MFDs still act on these broadcasts
// without that self-identification is unverified against real hardware;
// treat this module as unproven until tested (SPEC.md §13).
//
// Primary reference for message shapes: @canboat/ts-pgns (the structured
// PGN library signalk-fusion-stereo uses for PGN 126720 construction) --
// see ARCHITECTURE.md §5. TODO(implementation): this file is a stub; no
// PGN encoding exists yet.

import type { PlaybackState, Zone } from "../types.js";

export interface FusionAdapterOptions {
  deviceName: string;
  emitNmea2000: (pgn: string) => void;
}

export class FusionAdapter {
  constructor(private readonly opts: FusionAdapterOptions) {}

  /** Broadcast current playback/zone state as Fusion PGN 126720 messages
   * (SPEC.md §6.3). Called on every canonical-state change, plus on a
   * periodic refresh interval so a device joining the bus mid-session
   * still gets current state. */
  broadcastState(_playback: PlaybackState, _zones: Zone[]): void {
    // TODO(implementation): encode PGN 126720 track/volume/zone-status
    // messages. Deliberately not implemented until the PGN library choice
    // (ARCHITECTURE.md §5) is settled.
    void this.opts;
  }

  /** Decode an incoming Fusion PGN into a canonical-state command, or null
   * if it isn't a recognized Fusion-Link message. */
  decodeIncoming(_pgn: unknown): null {
    // TODO(implementation): decode incoming play/pause/volume/zone commands.
    return null;
  }
}
