import { createProxyMiddleware } from "http-proxy-middleware";
import type { RouterLike, ResponseLike } from "signalk-container-helper";

/** Mutable box for the container's resolved base URL (ARCHITECTURE.md §2.2)
 * -- registerWithRouter() runs synchronously, before container.start()
 * resolves an address, so index.ts fills this in once start() completes
 * and every proxied request reads it fresh. */
export interface MopidyProxyState {
  address: string | null;
}

// signalk-container-helper's RouterLike (managed-container.d.ts) only
// declares get/post, for its own minimal registerUpdateRoutes needs; the
// real object signalk-server passes to registerWithRouter is its actual
// Express Router, which also has .use() at runtime. Cast to this fuller
// shape to mount a catch-all proxy handler, the same way routes.ts casts
// req to an Express-shaped type.
interface ExpressRouterLike extends RouterLike {
  use(
    handler: (req: unknown, res: unknown, next: (err?: unknown) => void) => void,
  ): unknown;
}

/**
 * Reverse-proxies every request under this plugin's own router path
 * straight through to the running container's Mopidy HTTP server
 * (ARCHITECTURE.md §2.2) -- covers both the built-in minimal web UI
 * (image/webui, mounted at /jukebox/ inside the container) and Mopidy's
 * own JSON-RPC endpoint (/mopidy/rpc). No path rewriting: Express already
 * strips this router's own mount prefix before the middleware sees
 * req.url, so a request path relative to the plugin's mount point maps
 * 1:1 onto the same path inside the container.
 *
 * Must be registered AFTER every specific route (registerRoutes(),
 * registerUpdateRoutes()) -- it's a catch-all `.use()` with no path, so
 * anything registered after it would never be reached.
 *
 * WebSocket proxying (Mopidy's /mopidy/ws) is NOT wired up here -- that
 * needs the raw http.Server's 'upgrade' event, which this plugin has no
 * access to via signalk-container-helper's RouterLike. The built-in web
 * UI (image/webui/jukebox_webui/static/app.js) only polls the HTTP
 * JSON-RPC endpoint, so this isn't a gap for it -- revisit before
 * mounting a WS-dependent client (e.g. Iris, once compatible) here.
 */
export function registerMopidyProxy(
  router: RouterLike,
  state: MopidyProxyState,
): void {
  const proxy = createProxyMiddleware({
    router: () => state.address ?? undefined,
    changeOrigin: true,
  });
  (router as ExpressRouterLike).use((req, res, next) => {
    if (!state.address) {
      (res as ResponseLike)
        .status(503)
        .json({ error: "container not ready yet" });
      return;
    }
    void proxy(req as never, res as never, next as never);
  });
}
