import { describe, it, expect, vi } from "vitest";
import { registerRoutes } from "../src/routes.js";
import { StateStore } from "../src/state/store.js";
import type { SnapserverClient } from "../src/snapserver-client.js";
import type { CanonicalState, Zone } from "../src/types.js";
import type { RouterLike, ResponseLike } from "signalk-container-helper";

type PostHandler = (req: unknown, res: ResponseLike) => unknown;

function fakeRouter() {
  const posts: Record<string, PostHandler> = {};
  const router: RouterLike = {
    get: () => undefined,
    post: (path, handler) => {
      posts[path] = handler;
    },
  };
  return { router, posts };
}

// noUncheckedIndexedAccess makes posts[path] a `PostHandler | undefined` --
// this asserts the test itself registered the route it's about to invoke,
// rather than every call site repeating the same non-null assertion.
function callPost(
  posts: Record<string, PostHandler>,
  path: string,
  req: unknown,
  res: ResponseLike,
) {
  const handler = posts[path];
  if (!handler) throw new Error(`no handler registered for ${path}`);
  return handler(req, res);
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
    await callPost(posts, "/api/zones/:id/source", 
      { params: { id: "zone-1" }, body: { source: "jukebox" } },
      res,
    );

    expect(setGroupStream).toHaveBeenCalledWith("group-1", "MusicAndAlerts");
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
    await callPost(posts, "/api/zones/:id/source", 
      { params: { id: "zone-1" }, body: { source: "alerts" } },
      res,
    );

    expect(setGroupStream).toHaveBeenCalledWith("group-1", "Alerts");
    expect(res.body).toEqual({ ok: true });
    expect(store.getZone("zone-1")?.activeSource).toBe("alerts");
  });

  it("switches a zone to the silence stream", async () => {
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
    await callPost(posts, "/api/zones/:id/source", 
      { params: { id: "zone-1" }, body: { source: "silence" } },
      res,
    );

    expect(setGroupStream).toHaveBeenCalledWith("group-1", "Silence");
    expect(res.body).toEqual({ ok: true });
    expect(store.getZone("zone-1")?.activeSource).toBe("silence");
  });

  it("rejects a source other than jukebox/alerts/silence, e.g. airplay", async () => {
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
    callPost(posts, "/api/zones/:id/source", 
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
    callPost(posts, "/api/zones/:id/source", 
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
    callPost(posts, "/api/zones/:id/source", 
      { params: { id: "zone-1" }, body: { source: "jukebox" } },
      res,
    );

    expect(res.statusCode).toBe(503);
  });
});

describe("POST /api/zones/:id/delete", () => {
  it("deletes a disconnected zone", async () => {
    const store = makeStore({ ...zone, connected: false });
    const deleteClient = vi.fn().mockResolvedValue(undefined);
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: { deleteClient } as unknown as SnapserverClient },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    await callPost(posts, "/api/zones/:id/delete", { params: { id: "zone-1" } }, res);

    expect(deleteClient).toHaveBeenCalledWith("zone-1");
    expect(res.body).toEqual({ ok: true });
    expect(store.getZone("zone-1")).toBeUndefined();
  });

  it("refuses to delete a still-connected zone", async () => {
    const store = makeStore({ ...zone, connected: true });
    const deleteClient = vi.fn();
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: { deleteClient } as unknown as SnapserverClient },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    await callPost(posts, "/api/zones/:id/delete", { params: { id: "zone-1" } }, res);

    expect(res.statusCode).toBe(409);
    expect(deleteClient).not.toHaveBeenCalled();
    expect(store.getZone("zone-1")).toBeDefined();
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
    await callPost(posts, "/api/zones/:id/delete", 
      { params: { id: "does-not-exist" } },
      res,
    );

    expect(res.statusCode).toBe(404);
  });

  it("503s when the container isn't ready yet", async () => {
    const store = makeStore({ ...zone, connected: false });
    const { router, posts } = fakeRouter();
    registerRoutes({
      router,
      store,
      snapserver: { client: null },
      app: { getSelfPath: () => undefined },
    });

    const res = fakeRes();
    await callPost(posts, "/api/zones/:id/delete", { params: { id: "zone-1" } }, res);

    expect(res.statusCode).toBe(503);
  });
});
