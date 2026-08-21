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

export interface RegisterRoutesArgs {
  router: RouterLike;
  store: StateStore;
  snapserver: SnapserverClient;
}

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
    const volume = Number(req.body?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      res.status(400).json({ error: "volume must be 0-100" });
      return;
    }
    snapserver
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
    const muted = Boolean(req.body?.muted);
    snapserver
      .setClientVolume(zone.id, zone.volume, muted)
      .then(() => {
        store.setZone({ ...zone, muted });
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
