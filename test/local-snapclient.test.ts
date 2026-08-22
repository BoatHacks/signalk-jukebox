import { describe, it, expect } from "vitest";
import {
  buildLocalSnapclientConfig,
  LOCAL_SNAPCLIENT_IMAGE,
  SK_HOST_ALIAS,
} from "../src/local-snapclient.js";

describe("buildLocalSnapclientConfig", () => {
  it("points at the host-gateway alias, not a literal address", () => {
    const config = buildLocalSnapclientConfig("auto", {
      local: { enabled: true, soundCard: "plughw:CARD=wm8960soundcard,DEV=0", tag: "auto" },
    });
    expect(config.image).toBe(LOCAL_SNAPCLIENT_IMAGE);
    expect(config.env?.SNAPCAST_HOST).toBe(SK_HOST_ALIAS);
    expect(config.env?.SNAPCAST_PORT).toBe("1704");
    expect(config.extraHosts).toEqual({ [SK_HOST_ALIAS]: "host-gateway" });
  });

  it("forwards the configured sound card verbatim", () => {
    const config = buildLocalSnapclientConfig("auto", {
      local: { enabled: true, soundCard: "hw:CARD=Foo,DEV=1", tag: "auto" },
    });
    expect(config.env?.SOUND_CARD).toBe("hw:CARD=Foo,DEV=1");
  });

  it("requests /dev/snd + audio group passthrough", () => {
    const config = buildLocalSnapclientConfig("auto", {
      local: { enabled: true, soundCard: "hw:0", tag: "auto" },
    }) as { devices?: string[]; groupAdd?: string[] };
    expect(config.devices).toEqual(["/dev/snd"]);
    expect(config.groupAdd).toEqual(["audio"]);
  });
});
