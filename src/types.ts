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

export type ZoneActiveSource = "jukebox" | "alerts" | "silence";

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
}

/**
 * Persisted Snapclient id -> N2K zone number. Assigned once, the first
 * time a zone is ever seen, and never reassigned automatically thereafter
 * (SPEC.md §2, §4, §12 — this is what makes "Zone 1" on an MFD mean the
 * same physical speaker across restarts and reconnects).
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
  /** Zero or more managed companion containers (wyoming-bridge.ts), each
   * bridging one Wyoming voice satellite's speaker into a jukebox zone --
   * e.g. an espos-p4-cockpit panel's onboard speaker, which has no
   * Snapcast client of its own. Unlike localSnapclient (always exactly
   * one per plugin instance), this can be several -- an array, not a
   * single object, for the same RJSF admin-UI rendering reason
   * voiceDucking.satelliteZoneMap already is one (see that field's own
   * comment). */
  wyomingBridges: Array<{
    /** Stable key: this entry's Snapcast client id AND container name
     * suffix (wyoming-bridge.ts's WyomingBridgeEntryConfig). */
    id: string;
    enabled: boolean;
    zoneName: string;
    satelliteHost: string;
    satellitePort: number;
    tag: string;
  }>;
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
    // An array, replaced wholesale on save -- same reasoning as
    // voiceDucking.satelliteZoneMap above.
    wyomingBridges: rawConfig.wyomingBridges ?? SCHEMA_DEFAULTS.wyomingBridges,
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
  wyomingBridges: [],
};
