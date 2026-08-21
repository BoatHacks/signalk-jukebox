// Canonical state shapes. See SPEC.md §4 for the conceptual definitions and
// the rationale for why there is exactly one copy of each of these, shared
// by every interface (Mopidy adapter, N2K/Fusion adapter, REST, SK paths).
// See SPEC.md §3.2 / §12 for why writes are last-write-wins, confirmed
// against the real backend (Mopidy/Snapserver) rather than applied
// optimistically.

export type PlaybackStateValue = "stopped" | "playing" | "paused";

export interface Track {
  uri: string;
  name: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  positionMs?: number;
}

export interface PlaybackState {
  state: PlaybackStateValue;
  track?: Track;
  /** Master volume (SPEC.md §4) — distinct from per-zone volume below. */
  volume: number;
  muted: boolean;
}

export type ZoneActiveSource = "jukebox" | "airplay";

export interface ZoneAirPlayInfo {
  /** The mDNS name this zone's claimed slot advertises, once claimed. */
  streamName: string;
  /** Whether a device currently has an active AirPlay session to it. */
  connected: boolean;
}

export interface Zone {
  /** Snapclient id, as assigned by Snapserver. */
  id: string;
  name: string;
  connected: boolean;
  volume: number;
  muted: boolean;
  /** 0-3, present only if this zone was assigned an N2K/Fusion slot. */
  n2kZone?: number;
  activeSource: ZoneActiveSource;
  airplay?: ZoneAirPlayInfo;
}

/**
 * Persisted Snapclient id -> zone-numbering assignment. Assigned once, the
 * first time a zone is ever seen, and never reassigned automatically
 * thereafter (SPEC.md §2, §4, §6.4, §12 — this is what makes "Zone 1" on an
 * MFD, or a named AirPlay target, mean the same physical speaker across
 * restarts and reconnects).
 */
export interface ZoneAssignment {
  n2kZone?: number;
  airplaySlot?: number;
}

export type N2kDeviceState = "unclaimed" | "claimed";

/** The full canonical state held by the store (ARCHITECTURE.md §2.1). */
export interface CanonicalState {
  playback: PlaybackState;
  zones: Record<string, Zone>;
  zoneAssignments: Record<string, ZoneAssignment>;
  n2kDeviceState: N2kDeviceState;
}

export interface PluginSettings {
  libraryPath?: string;
  backends: {
    local: { enabled: boolean };
    radio: { enabled: boolean };
    spotify: {
      enabled: boolean;
      username?: string;
      password?: string;
    };
  };
  imageTag: string;
  n2k: {
    enabled: boolean;
    deviceName: string;
    deviceInstance: number;
  };
  airplay: {
    enabled: boolean;
    maxZones: number;
    namePattern: string;
  };
}

export const SCHEMA_DEFAULTS: PluginSettings = {
  backends: {
    local: { enabled: true },
    radio: { enabled: false },
    spotify: { enabled: false },
  },
  imageTag: "auto",
  n2k: {
    enabled: false,
    deviceName: "Jukebox",
    deviceInstance: 0,
  },
  airplay: {
    enabled: true,
    maxZones: 4,
    namePattern: "{boatName} - {zoneName}",
  },
};
