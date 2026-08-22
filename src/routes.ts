import type { RouterLike } from "signalk-container-helper";
import type { StateStore } from "./state/store.js";
import type { SnapserverClient } from "./snapserver-client.js";

// RouterLike's handler receives `req: unknown` (signalk-container-helper is
// transport-agnostic); this plugin runs on SignalK's Express router, so a
// minimal Express-shaped view is cast in at each handler.
interface ExpressLikeRequest {
  params: { id: string };
  body?: Record<string, unknown>;
}

// REST routes under /plugins/signalk-jukebox (SPEC.md §6.1). All routes
// read from / write to the canonical StateStore -- never to Mopidy or
// Snapserver directly -- so REST is a peer of every other interface
// (ARCHITECTURE.md §2.1), not a special case.

/** Mutable box for the real SnapserverClient -- registerWithRouter() runs
 * synchronously, before container.start() resolves and the client can be
 * constructed against its real host:port, so index.ts fills this in once
 * start() completes (same pattern as proxy.ts's MopidyProxyState). */
export interface SnapserverClientState {
  client: SnapserverClient | null;
}

export interface RegisterRoutesArgs {
  router: RouterLike;
  store: StateStore;
  snapserver: SnapserverClientState;
}

const JUKEBOX_STREAM_ID = "Jukebox";

export function registerRoutes({
  router,
  store,
  snapserver,
}: RegisterRoutesArgs): void {
  router.get("/api/status", (_req, res) => {
    res.json(store.getPlayback());
  });

  router.get("/api/zones", (_req, res) => {
    res.json(store.getZones());
  });

  router.post("/api/zones/:id/volume", (rawReq, res) => {
    const req = rawReq as ExpressLikeRequest;
    const zone = store.getZone(req.params.id);
    if (!zone) {
      res.status(404).json({ error: "unknown zone" });
      return;
    }
    if (!snapserver.client) {
      res.status(503).json({ error: "container not ready yet" });
      return;
    }
    const volume = Number(req.body?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      res.status(400).json({ error: "volume must be 0-100" });
      return;
    }
    snapserver.client
      .setClientVolume(zone.id, volume, zone.muted)
      .then(() => {
        store.setZone({ ...zone, volume });
        res.json({ ok: true });
      })
      .catch((err: unknown) => {
        res.status(502).json({ error: String(err) });
      });
  });

  router.post("/api/zones/:id/mute", (rawReq, res) => {
    const req = rawReq as ExpressLikeRequest;
    const zone = store.getZone(req.params.id);
    if (!zone) {
      res.status(404).json({ error: "unknown zone" });
      return;
    }
    if (!snapserver.client) {
      res.status(503).json({ error: "container not ready yet" });
      return;
    }
    const muted = Boolean(req.body?.muted);
    snapserver.client
      .setClientVolume(zone.id, zone.volume, muted)
      .then(() => {
        store.setZone({ ...zone, muted });
        res.json({ ok: true });
      })
      .catch((err: unknown) => {
        res.status(502).json({ error: String(err) });
      });
  });

  // Which source plays in this zone (the web UI's zone/source picker).
  // Only "jukebox" is settable here -- a zone's AirPlay stream is switched
  // to automatically on connect (SPEC.md §6.4, §12: "connecting is the
  // switch"), never chosen manually, so there is nothing for this route to
  // apply if asked for "airplay".
  router.post("/api/zones/:id/source", (rawReq, res) => {
    const req = rawReq as ExpressLikeRequest;
    const zone = store.getZone(req.params.id);
    if (!zone) {
      res.status(404).json({ error: "unknown zone" });
      return;
    }
    if (!snapserver.client) {
      res.status(503).json({ error: "container not ready yet" });
      return;
    }
    const source = req.body?.source;
    if (source !== "jukebox") {
      res.status(400).json({ error: 'source must be "jukebox"' });
      return;
    }
    snapserver.client
      .setGroupStream(zone.groupId, JUKEBOX_STREAM_ID)
      .then(() => {
        store.setZone({ ...zone, activeSource: "jukebox" });
        res.json({ ok: true });
      })
      .catch((err: unknown) => {
        res.status(502).json({ error: String(err) });
      });
  });

  // GET /api/update/check, POST /api/update/apply, GET /api/versions are
  // registered separately via ManagedContainer.registerUpdateRoutes()
  // (see index.ts), following signalk-container-helper's convention.
}
