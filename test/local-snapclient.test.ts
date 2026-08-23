import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildLocalSnapclientConfig,
  renameLocalSnapclientZone,
  LOCAL_SNAPCLIENT_IMAGE,
  LOCAL_SNAPCLIENT_HOST_ID,
  SK_HOST_ALIAS,
  type RenameableSnapserverClient,
} from "../src/local-snapclient.js";

describe("buildLocalSnapclientConfig", () => {
  it("points at the host-gateway alias, not a literal address", () => {
    const config = buildLocalSnapclientConfig("auto", {
      local: {
        enabled: true,
        soundCard: "plughw:CARD=wm8960soundcard,DEV=0",
        tag: "auto",
        zoneName: "Local speakers",
      },
    });
    expect(config.image).toBe(LOCAL_SNAPCLIENT_IMAGE);
    expect(config.env?.SNAPCAST_HOST).toBe(SK_HOST_ALIAS);
    expect(config.env?.SNAPCAST_PORT).toBe("1704");
    expect(config.extraHosts).toEqual({ [SK_HOST_ALIAS]: "host-gateway" });
  });

  it("forwards the configured sound card verbatim", () => {
    const config = buildLocalSnapclientConfig("auto", {
      local: {
        enabled: true,
        soundCard: "hw:CARD=Foo,DEV=1",
        tag: "auto",
        zoneName: "Local speakers",
      },
    });
    expect(config.env?.SOUND_CARD).toBe("hw:CARD=Foo,DEV=1");
  });

  it("requests /dev/snd + audio group passthrough", () => {
    const config = buildLocalSnapclientConfig("auto", {
      local: {
        enabled: true,
        soundCard: "hw:0",
        tag: "auto",
        zoneName: "Local speakers",
      },
    }) as { devices?: string[]; groupAdd?: string[] };
    expect(config.devices).toEqual(["/dev/snd"]);
    expect(config.groupAdd).toEqual(["audio"]);
  });
});

describe("renameLocalSnapclientZone", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sets the name as soon as the known client id appears", async () => {
    const setClientName = vi.fn().mockResolvedValue(undefined);
    const snapserver: RenameableSnapserverClient = {
      getGroups: vi
        .fn()
        .mockResolvedValue([{ clients: [{ id: LOCAL_SNAPCLIENT_HOST_ID }] }]),
      setClientName,
    };

    renameLocalSnapclientZone(snapserver, "Local speakers");
    await vi.waitFor(() =>
      expect(setClientName).toHaveBeenCalledWith(
        LOCAL_SNAPCLIENT_HOST_ID,
        "Local speakers",
      ),
    );
  });

  it("retries until the client appears, then stops polling", async () => {
    const setClientName = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    const getGroups = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call < 3 ? [] : [{ clients: [{ id: LOCAL_SNAPCLIENT_HOST_ID }] }],
      );
    });
    renameLocalSnapclientZone({ getGroups, setClientName }, "Local speakers", {
      intervalMs: 10,
    });

    // Generous budget covering several retries -- exact tick-by-tick
    // call counts against fake timers are too implementation-detail-
    // fragile to assert on; what matters is it eventually finds the
    // client and renames it exactly once.
    await vi.advanceTimersByTimeAsync(10 * 10);
    expect(setClientName).toHaveBeenCalledTimes(1);
    expect(setClientName).toHaveBeenCalledWith(
      LOCAL_SNAPCLIENT_HOST_ID,
      "Local speakers",
    );
    expect(getGroups.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Confirmed it stopped polling once found: no further calls even
    // after much more time passes.
    const callsAfterFound = getGroups.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(callsAfterFound);
    expect(setClientName).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts without ever finding the client", async () => {
    const getGroups = vi.fn().mockResolvedValue([]);
    const setClientName = vi.fn();
    renameLocalSnapclientZone({ getGroups, setClientName }, "Local speakers", {
      intervalMs: 10,
      maxAttempts: 3,
    });

    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(3);
    expect(setClientName).not.toHaveBeenCalled();

    // Confirmed it actually gave up: no further calls even after more
    // time passes.
    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(3);
  });

  it("stop() cancels any pending retry", async () => {
    const getGroups = vi.fn().mockResolvedValue([]);
    const setClientName = vi.fn();
    const stop = renameLocalSnapclientZone(
      { getGroups, setClientName },
      "Local speakers",
      { intervalMs: 10 },
    );

    await vi.advanceTimersByTimeAsync(10 * 3);
    stop();
    const callsAtStop = getGroups.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10 * 20);
    expect(getGroups).toHaveBeenCalledTimes(callsAtStop);
    expect(setClientName).not.toHaveBeenCalled();
  });
});
