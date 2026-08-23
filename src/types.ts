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

export type ZoneActiveSource = "jukebox" | "alerts" | "silence" | "airplay";

export interface AirPlayTrack {
  title: string;
  artist?: string;
  album?: string;
}

export interface ZoneAirPlayInfo {
  /** The mDNS name this zone's receiver was created with (SPEC.md §6.4). */
  streamName: string;
  /** Whether a device currently has an active AirPlay session to it. */
  connected: boolean;
  /** From shairport-sync's metadata pipe (SPEC.md §6.3, §6.4). Absent
   * until the sending device/app pushes metadata -- not every AirPlay
   * source does, and it can lag session start -- so absence means
   * "nothing received yet," not "definitely nothing," and callers fall
   * back to a placeholder rather than treating it as an error. */
  track?: AirPlayTrack;
}

export interface Zone {
  /** Snapclient id, as assigned by Snapserver. */
  id: string;
  /** This zone's own Snapcast group id -- each zone keeps one group for
   * its whole lifetime (SPEC.md §2, §12); switching source is
   * Group.SetStream on it, never a client reassignment between groups. */
  groupId: string;
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
 * Persisted Snapclient id -> N2K zone number. Assigned once, the first
 * time a zone is ever seen, and never reassigned automatically thereafter
 * (SPEC.md §2, §4, §12 — this is what makes "Zone 1" on an MFD mean the
 * same physical speaker across restarts and reconnects). AirPlay has no
 * equivalent here (SPEC.md §6.4, §12) -- a zone's AirPlay receiver is
 * created/removed on demand, not claimed from a persisted slot.
 */
export interface ZoneAssignment {
  n2kZone?: number;
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
    /** Mopidy-TuneIn (SPEC.md §12) -- no credentials needed. */
    radio: { enabled: boolean };
    spotify: {
      /** SPEC.md §5, §13: currently degraded upstream (mopidy-spotify#437,
       * an open login5 auth issue) -- not a solid MVP feature yet. */
      enabled: boolean;
      /** Registered app OAuth credentials (SPEC.md §9, §13). NOT
       * username/password -- Spotify disabled that login path for
       * third-party clients entirely as of Mopidy-Spotify v5.0.0. */
      clientId?: string;
      clientSecret?: string;
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
    namePattern: string;
    /** Run the container with host networking instead of a bridged/NAT
     * network (ARCHITECTURE.md §5, §6, confirmed by build-testing).
     * AirPlay discovery (mDNS) and each per-zone receiver's own
     * dynamically-chosen RTSP/RTP ports don't traverse a bridge/NAT
     * boundary to the LAN at all -- there is no fixed port list to
     * publish individually the way Snapcast's stream port can be, since
     * each zone's shairport-sync instance is created on demand (§6.4).
     * Host networking removes that boundary entirely, at the cost of
     * this container sharing the host's network namespace and port space
     * with every other process on it -- default off; AirPlay zones won't
     * be discoverable by real devices until this is enabled. */
    hostNetworking: boolean;
  };
  vhf: {
    enabled: boolean;
    resumeDelaySeconds: number;
  };
  voiceDucking: {
    enabled: boolean;
    duckVolumePercent: number;
    resumeDelaySeconds: number;
    /** voice.satellites.<id> -> jukebox zone id (SPEC.md §6.5, §9).
     * Unmapped satellites duck all zones (safe fallback). An array of
     * pairs, not a Record<string, string> map: confirmed by build-testing
     * against the real Admin UI (RJSF v5) that its `additionalProperties`
     * free-form map rendering doesn't render anything at all here (no add
     * button, no rows -- just the title, unusably) even though other
     * plain-object schema fields on the same page render fine. An array
     * of `{ satelliteId, zoneId }` objects uses RJSF's array-of-objects
     * field instead, which does render an editable, add/removable list. */
    satelliteZoneMap: Array<{ satelliteId: string; zoneId: string }>;
  };
  /** Optional second managed container (local-snapclient.ts, SPEC.md §9,
   * §12): runs signalk-jukebox's own minimal snapclient image on this
   * same host, for speakers wired directly to the SignalK server's own
   * machine rather than a separate physical Snapclient device. */
  localSnapclient: {
    enabled: boolean;
    /** ALSA device string, e.g. "plughw:CARD=wm8960soundcard,DEV=0" --
     * required when enabled, no "auto" fallback (see
     * local-snapclient.ts's own doc comment for why). */
    soundCard: string;
    tag: string;
    /** Human-readable zone name (Snapcast's Client.SetName, SPEC.md §9) --
     * without this, the zone falls back to Snapcast's own default of
     * the client's raw hostname (e.g. "16684a3df93c", a podman-assigned
     * container id), confirmed by build-testing. */
    zoneName: string;
  };
}

/** Merge a saved/partial config over SCHEMA_DEFAULTS, one level into each
 * nested settings group -- a plain `{ ...SCHEMA_DEFAULTS, ...rawConfig }`
 * silently drops an entire nested group's defaults (e.g. backends.radio,
 * backends.spotify) whenever the saved config doesn't happen to include
 * every group, which then crashes `container.ts`'s buildConfig() reading
 * `.enabled` off the resulting `undefined` (confirmed against a real
 * signalk-server: a config saved with only `backends.local` set threw
 * "Cannot read properties of undefined (reading 'enabled')" on start). */
export function mergeSettings(
  rawConfig: Partial<PluginSettings>,
): PluginSettings {
  return {
    ...SCHEMA_DEFAULTS,
    ...rawConfig,
    backends: {
      local: {
        ...SCHEMA_DEFAULTS.backends.local,
        ...rawConfig.backends?.local,
      },
      radio: {
        ...SCHEMA_DEFAULTS.backends.radio,
        ...rawConfig.backends?.radio,
      },
      spotify: {
        ...SCHEMA_DEFAULTS.backends.spotify,
        ...rawConfig.backends?.spotify,
      },
    },
    n2k: { ...SCHEMA_DEFAULTS.n2k, ...rawConfig.n2k },
    airplay: { ...SCHEMA_DEFAULTS.airplay, ...rawConfig.airplay },
    vhf: { ...SCHEMA_DEFAULTS.vhf, ...rawConfig.vhf },
    voiceDucking: {
      ...SCHEMA_DEFAULTS.voiceDucking,
      ...rawConfig.voiceDucking,
      // An array, unlike the nested objects above -- replaced wholesale
      // rather than merged entry-by-entry, matching how the admin UI's
      // array field always submits the complete list on save.
      satelliteZoneMap:
        rawConfig.voiceDucking?.satelliteZoneMap ??
        SCHEMA_DEFAULTS.voiceDucking.satelliteZoneMap,
    },
    localSnapclient: {
      ...SCHEMA_DEFAULTS.localSnapclient,
      ...rawConfig.localSnapclient,
    },
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
    namePattern: "{boatName} - {zoneName}",
    hostNetworking: false,
  },
  vhf: {
    enabled: true,
    resumeDelaySeconds: 5,
  },
  voiceDucking: {
    enabled: true,
    duckVolumePercent: 20,
    resumeDelaySeconds: 1,
    satelliteZoneMap: [],
  },
  localSnapclient: {
    enabled: false,
    soundCard: "",
    tag: "auto",
    zoneName: "Local speakers",
  },
};
