import type { RouterLike } from "signalk-container-helper";
import type { StateStore } from "./state/store.js";
import type { SnapserverClient } from "./snapserver-client.js";
import { fetchGhcrVersions } from "./ghcr-versions.js";
import { JUKEBOX_IMAGE } from "./container.js";

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

export interface SatellitesAppLike {
  /** Standard SignalK plugin app API (@signalk/server-api's AppLike) --
   * returns the value at a vessels.self-relative path, or undefined if
   * nothing's ever been received there. */
  getSelfPath(path: string): unknown;
}

export interface RegisterRoutesArgs {
  router: RouterLike;
  store: StateStore;
  snapserver: SnapserverClientState;
  app: SatellitesAppLike;
}

// "MusicAndAlerts" (not the raw "MopidyOnly" stream) is what a zone gets
// assigned to for "play the jukebox" -- Snapcast's own auto-ducking meta
// stream (snapserver.conf.template, zone-sync.ts's own comment on this).
const JUKEBOX_STREAM_ID = "MusicAndAlerts";
const ALERTS_STREAM_ID = "Alerts";
const SILENCE_STREAM_ID = "Silence";

export function registerRoutes({
  router,
  store,
  snapserver,
  app,
}: RegisterRoutesArgs): void {
  router.get("/api/status", (_req, res) => {
    res.json(store.getPlayback());
  });

  router.get("/api/zones", (_req, res) => {
    res.json(store.getZones());
  });

  // Backs the config panel's satellite-id dropdown for voiceDucking.
  // satelliteZoneMap (SPEC.md §6.5, §9) -- voice.satellites.<id> is an
  // external, optional delta from signalk-wyoming (ARCHITECTURE.md §2.5);
  // this plugin doesn't track satellites itself, so it just reads
  // whatever's currently in SignalK's own data model at that path, the
  // same way it would read any other plugin's delta.
  router.get("/api/satellites", (_req, res) => {
    const satellites = app.getSelfPath("voice.satellites");
    const ids =
      satellites && typeof satellites === "object"
        ? Object.keys(satellites)
        : [];
    res.json({ ids });
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
  // "jukebox", "alerts", and "silence" are settable here -- "alerts"
  // (container.ts's ALERTS_STREAM_ID, a standing announcement-intake
  // stream, SPEC.md §6, §12) is how a zone can be taken off the jukebox
  // stream without muting the Snapclient outright, so it still hears
  // announcements; "silence" (SILENCE_STREAM_ID) is for a zone that
  // shouldn't hear anything at all, not even announcements, e.g. a
  // sleeping cabin. "airplay" is NOT settable here -- a zone's AirPlay
  // stream is switched to automatically on connect (SPEC.md §6.4, §12:
  // "connecting is the switch"), never chosen manually, so there is
  // nothing for this route to apply if asked for it.
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
    if (source !== "jukebox" && source !== "alerts" && source !== "silence") {
      res.status(400).json({ error: 'source must be "jukebox", "alerts", or "silence"' });
      return;
    }
    const streamId =
      source === "jukebox"
        ? JUKEBOX_STREAM_ID
        : source === "alerts"
          ? ALERTS_STREAM_ID
          : SILENCE_STREAM_ID;
    snapserver.client
      .setGroupStream(zone.groupId, streamId)
      .then(() => {
        store.setZone({ ...zone, activeSource: source });
        res.json({ ok: true });
      })
      .catch((err: unknown) => {
        res.status(502).json({ error: String(err) });
      });
  });

  // GET /api/update/check and POST /api/update/apply are registered
  // separately via ManagedContainer.registerUpdateRoutes() (see index.ts).
  // /api/versions is NOT part of that helper -- it only covers the single
  // "latest available version" check/apply flow (VersionSourceSpec has no
  // GHCR-tags-list variant), so the config panel's version dropdown is
  // backed by ghcr-versions.ts here instead (SPEC.md §6.1).
  router.get("/api/versions", (_req, res) => {
    fetchGhcrVersions(JUKEBOX_IMAGE)
      .then((versions) => res.json({ versions }))
      .catch((err: unknown) => {
        res.status(502).json({ error: String(err) });
      });
  });
}
