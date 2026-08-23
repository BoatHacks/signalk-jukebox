import { describe, it, expect } from "vitest";
import {
  buildJukeboxConfig,
  JUKEBOX_IMAGE,
  MOPIDY_PORT,
  SNAPCAST_STREAM_PORT,
  SNAPCAST_CONTROL_PORT,
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
});
