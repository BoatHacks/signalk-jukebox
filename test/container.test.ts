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

describe("buildJukeboxConfig", () => {
  it("publishes signalkAccessiblePorts and ports", () => {
    const config = buildJukeboxConfig("latest", SCHEMA_DEFAULTS);
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

  it("mounts /data when dataMount is given, alongside /music when libraryMount is also given", () => {
    const config: PluginSettings = SCHEMA_DEFAULTS;
    const built = buildJukeboxConfig(
      "latest",
      config,
      { source: "/host/music", containerPath: "/music" },
      { source: "/host/plugin-data", containerPath: "/data" },
    );
    expect(built.volumes).toEqual({
      "/music": "/host/music",
      "/data": "/host/plugin-data",
    });
  });

  it("mounts only /data when libraryMount is absent", () => {
    const built = buildJukeboxConfig("latest", SCHEMA_DEFAULTS, undefined, {
      source: "/host/plugin-data",
      containerPath: "/data",
    });
    expect(built.volumes).toEqual({ "/data": "/host/plugin-data" });
  });

  it("omits volumes entirely when neither mount is given", () => {
    const built = buildJukeboxConfig("latest", SCHEMA_DEFAULTS);
    expect(built.volumes).toBeUndefined();
  });
});
