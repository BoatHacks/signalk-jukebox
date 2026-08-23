import { describe, it, expect, vi } from "vitest";
import {
  registerPlaybackVolumePutHandler,
  registerZonePutHandlers,
  type ActionHandler,
  type ActionResult,
  type PutHandlerAppLike,
  type MopidyClientState,
} from "../src/put-handlers.js";
import type { SnapserverClientState } from "../src/routes.js";
import { StateStore, createInitialState } from "../src/state/store.js";
import type { MopidyClient } from "../src/mopidy-client.js";
import type { SnapserverClient } from "../src/snapserver-client.js";

function fakeApp(): { app: PutHandlerAppLike; handlers: Map<string, ActionHandler> } {
  const handlers = new Map<string, ActionHandler>();
  return {
    app: {
      registerPutHandler: (_context, path, callback) => {
        handlers.set(path, callback);
      },
    },
    handlers,
  };
}

function callHandler(
  handler: ActionHandler,
  value: unknown,
): Promise<ActionResult> {
  return new Promise((resolve) => {
    const result = handler("vessels.self", "irrelevant", value, resolve);
    if (result.state !== "PENDING") resolve(result);
  });
}

describe("registerPlaybackVolumePutHandler", () => {
  it("503s when the container isn't ready yet", async () => {
    const { app, handlers } = fakeApp();
    const store = new StateStore(createInitialState());
    const mopidyState: MopidyClientState = { client: null };
    registerPlaybackVolumePutHandler(app, mopidyState, store);

    const result = await callHandler(
      handlers.get("entertainment.jukebox.playback.volume")!,
      50,
    );
    expect(result.statusCode).toBe(503);
  });

  it("rejects an out-of-range volume", async () => {
    const { app, handlers } = fakeApp();
    const store = new StateStore(createInitialState());
    const mopidyState: MopidyClientState = {
      client: { setVolume: vi.fn() } as unknown as MopidyClient,
    };
    registerPlaybackVolumePutHandler(app, mopidyState, store);

    const result = await callHandler(
      handlers.get("entertainment.jukebox.playback.volume")!,
      101,
    );
    expect(result.statusCode).toBe(400);
  });

  it("calls MopidyClient.setVolume and updates the store on success", async () => {
    const { app, handlers } = fakeApp();
    const store = new StateStore(createInitialState());
    const setVolume = vi.fn().mockResolvedValue(true);
    const mopidyState: MopidyClientState = {
      client: { setVolume } as unknown as MopidyClient,
    };
    registerPlaybackVolumePutHandler(app, mopidyState, store);

    const result = await callHandler(
      handlers.get("entertainment.jukebox.playback.volume")!,
      42,
    );
    expect(setVolume).toHaveBeenCalledWith(42);
    expect(store.getPlayback().volume).toBe(42);
    expect(result.statusCode).toBe(200);
  });
});

describe("registerZonePutHandlers", () => {
  it("registers volume/muted handlers only once a zone is first seen", () => {
    const { app, handlers } = fakeApp();
    const store = new StateStore(createInitialState());
    const snapserverState: SnapserverClientState = { client: null };
    registerZonePutHandlers(app, snapserverState, store);

    expect(handlers.has("entertainment.jukebox.zones.z1.volume")).toBe(false);

    store.setZone({
      id: "z1",
      groupId: "g1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      activeSource: "jukebox",
    });

    expect(handlers.has("entertainment.jukebox.zones.z1.volume")).toBe(true);
    expect(handlers.has("entertainment.jukebox.zones.z1.muted")).toBe(true);
  });

  it("writes through setClientVolume and updates the store", async () => {
    const { app, handlers } = fakeApp();
    const store = new StateStore(createInitialState());
    const setClientVolume = vi.fn().mockResolvedValue(true);
    const snapserverState: SnapserverClientState = {
      client: { setClientVolume } as unknown as SnapserverClient,
    };
    registerZonePutHandlers(app, snapserverState, store);
    store.setZone({
      id: "z1",
      groupId: "g1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      activeSource: "jukebox",
    });

    const result = await callHandler(
      handlers.get("entertainment.jukebox.zones.z1.volume")!,
      80,
    );
    expect(setClientVolume).toHaveBeenCalledWith("z1", 80, false);
    expect(store.getZone("z1")?.volume).toBe(80);
    expect(result.statusCode).toBe(200);
  });

  it("404s a volume PUT for an unknown zone id", async () => {
    const { app, handlers } = fakeApp();
    const store = new StateStore(createInitialState());
    const snapserverState: SnapserverClientState = {
      client: { setClientVolume: vi.fn() } as unknown as SnapserverClient,
    };
    registerZonePutHandlers(app, snapserverState, store);
    store.setZone({
      id: "z1",
      groupId: "g1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      activeSource: "jukebox",
    });
    store.removeZone("z1");

    const result = await callHandler(
      handlers.get("entertainment.jukebox.zones.z1.volume")!,
      80,
    );
    expect(result.statusCode).toBe(404);
  });

  it("does not re-register on repeated zone-sync polls of the same zone", () => {
    const { app } = fakeApp();
    const registerPutHandler = vi.spyOn(app, "registerPutHandler");
    const store = new StateStore(createInitialState());
    const snapserverState: SnapserverClientState = { client: null };
    registerZonePutHandlers(app, snapserverState, store);

    const zone = {
      id: "z1",
      groupId: "g1",
      name: "Salon",
      connected: true,
      volume: 50,
      muted: false,
      activeSource: "jukebox" as const,
    };
    store.setZone(zone);
    store.setZone(zone);
    store.setZone(zone);

    expect(registerPutHandler).toHaveBeenCalledTimes(2);
  });
});
