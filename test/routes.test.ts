import { describe, it, expect, vi } from "vitest";
import { registerRoutes } from "../src/routes.js";
import { StateStore } from "../src/state/store.js";
import type { SnapserverClient } from "../src/snapserver-client.js";
import type { CanonicalState, Zone } from "../src/types.js";

function fakeRouter() {
  const posts: Record<string, (req: unknown, res: unknown) => unknown> = {};
  return {
    router: {
      get: () => undefined,
      post: (path: string, handler: (req: unknown, res: unknown) => unknown) => {
        posts[path] = handler;
      },
    },
    posts,
  };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeStore(zone: Zone): StateStore {
  const initial: CanonicalState = {
    playback: { state: "stopped", volume: 0, muted: false },
    zones: { [zone.id]: zone },
    zoneAssignments: {},
    n2kDeviceState: "unclaimed",
  };
  return new StateStore(initial);
}

const zone: Zone = {
  id: "zone-1",
  groupId: "group-1",
  name: "Salon",
  connected: true,
  volume: 50,
  muted: false,
  activeSource: "airplay",
};

describe("POST /api/zones/:id/source", () => {
  it("switches a zone to the jukebox stream", async () => {
    const store = makeStore(zone);
    const setGroupStream = vi.fn().mockResolvedValue(undefined);
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: { setGroupStream } as unknown as SnapserverClient },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    await posts["/api/zones/:id/source"](
      { params: { id: "zone-1" }, body: { source: "jukebox" } },
      res,
    );

    expect(setGroupStream).toHaveBeenCalledWith("group-1", "Jukebox");
    expect(res.body).toEqual({ ok: true });
    expect(store.getZone("zone-1")?.activeSource).toBe("jukebox");
  });

  it("switches a zone to the alerts stream", async () => {
    const store = makeStore({ ...zone, activeSource: "jukebox" });
    const setGroupStream = vi.fn().mockResolvedValue(undefined);
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: { setGroupStream } as unknown as SnapserverClient },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    await posts["/api/zones/:id/source"](
      { params: { id: "zone-1" }, body: { source: "alerts" } },
      res,
    );

    expect(setGroupStream).toHaveBeenCalledWith("group-1", "Alerts");
    expect(res.body).toEqual({ ok: true });
    expect(store.getZone("zone-1")?.activeSource).toBe("alerts");
  });

  it("rejects a source other than jukebox/alerts, e.g. airplay", async () => {
    const store = makeStore(zone);
    const setGroupStream = vi.fn();
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: { setGroupStream } as unknown as SnapserverClient },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    posts["/api/zones/:id/source"](
      { params: { id: "zone-1" }, body: { source: "airplay" } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(setGroupStream).not.toHaveBeenCalled();
  });

  it("404s for an unknown zone", async () => {
    const store = makeStore(zone);
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: {} as unknown as SnapserverClient },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    posts["/api/zones/:id/source"](
      { params: { id: "does-not-exist" }, body: { source: "jukebox" } },
      res,
    );

    expect(res.statusCode).toBe(404);
  });

  it("503s when the container isn't ready yet", async () => {
    const store = makeStore(zone);
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: null },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    posts["/api/zones/:id/source"](
      { params: { id: "zone-1" }, body: { source: "jukebox" } },
      res,
    );

    expect(res.statusCode).toBe(503);
  });
});
