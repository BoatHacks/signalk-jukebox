import { describe, it, expect } from "vitest";
import {
  buildJukeboxConfig,
  JUKEBOX_IMAGE,
  MOPIDY_PORT,
  SNAPCAST_STREAM_PORT,
  SNAPCAST_CONTROL_PORT,
  SNAPWEB_PORT,
  ALERTS_PORT,
} from "../src/container.js";
import { SCHEMA_DEFAULTS, type PluginSettings } from "../src/types.js";

function settingsWith(
  overrides: Partial<PluginSettings["airplay"]>,
): PluginSettings {
  return {
    ...SCHEMA_DEFAULTS,
    airplay: { ...SCHEMA_DEFAULTS.airplay, ...overrides },
  };
}

describe("buildJukeboxConfig", () => {
  it("publishes signalkAccessiblePorts and ports normally (no host networking)", () => {
    const config = buildJukeboxConfig(
      "latest",
      settingsWith({ hostNetworking: false }),
    );
    expect(config.image).toBe(JUKEBOX_IMAGE);
    expect(config.signalkAccessiblePorts).toEqual([MOPIDY_PORT]);
    expect(config.ports).toEqual({
      [`${SNAPCAST_STREAM_PORT}/tcp`]: `0.0.0.0:${SNAPCAST_STREAM_PORT}`,
      [`${SNAPCAST_CONTROL_PORT}/tcp`]: `127.0.0.1:${SNAPCAST_CONTROL_PORT}`,
      [`${SNAPWEB_PORT}/tcp`]: `0.0.0.0:${SNAPWEB_PORT}`,
      [`${ALERTS_PORT}/tcp`]: `0.0.0.0:${ALERTS_PORT}`,
      [`${MOPIDY_PORT}/tcp`]: `0.0.0.0:${MOPIDY_PORT}`,
    });
    expect(config.networkMode).toBeUndefined();
  });

  it("omits signalkAccessiblePorts and ports under host networking, never combining them with networkMode", () => {
    const config = buildJukeboxConfig(
      "latest",
      settingsWith({ hostNetworking: true }),
    );
    // The real bug this guards against: signalk-container discards
    // networkMode entirely if signalkAccessiblePorts is also set, so
    // these two must never both be present at once.
    expect(config.networkMode).toBe("host");
    expect(config.signalkAccessiblePorts).toBeUndefined();
    expect(config.ports).toBeUndefined();
  });

  it("mounts /data when dataMount is given, alongside /music when libraryMount is also given", () => {
    const config = buildJukeboxConfig(
      "latest",
      settingsWith({ hostNetworking: false }),
      { source: "/host/music", containerPath: "/music" },
      { source: "/host/plugin-data", containerPath: "/data" },
    );
    expect(config.volumes).toEqual({
      "/music": "/host/music",
      "/data": "/host/plugin-data",
    });
  });

  it("mounts only /data when libraryMount is absent", () => {
    const config = buildJukeboxConfig(
      "latest",
      settingsWith({ hostNetworking: false }),
      undefined,
      { source: "/host/plugin-data", containerPath: "/data" },
    );
    expect(config.volumes).toEqual({ "/data": "/host/plugin-data" });
  });

  it("omits volumes entirely when neither mount is given", () => {
    const config = buildJukeboxConfig(
      "latest",
      settingsWith({ hostNetworking: false }),
    );
    expect(config.volumes).toBeUndefined();
  });

  it("passes the AirPlay enabled flag and a percent-encoded, boat-prefixed devicename", () => {
    const config = buildJukeboxConfig(
      "latest",
      settingsWith({ enabled: true }),
      undefined,
      undefined,
      "Tinarasia",
    );
    expect(config.env?.JUKEBOX_AIRPLAY_ENABLED).toBe("true");
    // Not a raw space: confirmed live that breaks the rendered
    // airplay://...?devicename=... URI's own query-string parsing.
    expect(config.env?.JUKEBOX_AIRPLAY_DEVICENAME).toBe(
      "Tinarasia%20-%20AirPlay",
    );
  });

  it("falls back to a generic boat name when none is given", () => {
    const config = buildJukeboxConfig("latest", settingsWith({}));
    expect(config.env?.JUKEBOX_AIRPLAY_DEVICENAME).toBe("Boat%20-%20AirPlay");
  });

  it("reflects airplay.enabled=false in the env flag", () => {
    const config = buildJukeboxConfig(
      "latest",
      settingsWith({ enabled: false }),
    );
    expect(config.env?.JUKEBOX_AIRPLAY_ENABLED).toBe("false");
  });
});
