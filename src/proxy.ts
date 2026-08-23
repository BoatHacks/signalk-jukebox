import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
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
    handler: (
      req: unknown,
      res: unknown,
      next: (err?: unknown) => void,
    ) => void,
  ): unknown;
}

/**
 * Reverse-proxies every request under this plugin's own router path
 * straight through to the running container's Mopidy HTTP server
 * (ARCHITECTURE.md §2.2) -- Mopidy's own JSON-RPC endpoint (/mopidy/rpc),
 * for external tooling that wants to reach it through SignalK's own
 * authenticated port rather than Mopidy's own LAN-published one. No path
 * rewriting: Express already strips this router's own mount prefix before
 * the middleware sees req.url, so a request path relative to the plugin's
 * mount point maps 1:1 onto the same path inside the container.
 *
 * Must be registered AFTER every specific route (registerRoutes(),
 * registerUpdateRoutes()) -- it's a catch-all `.use()` with no path, so
 * anything registered after it would never be reached.
 *
 * WebSocket proxying (Mopidy's /mopidy/ws) is NOT wired up here -- that
 * needs the raw http.Server's 'upgrade' event, which this plugin has no
 * access to via signalk-container-helper's RouterLike. This is why the
 * web client (Mopidy-MusicBox-Webclient, image/Dockerfile) is NOT reached
 * through this proxy at all -- its whole UI runs over that WebSocket
 * (confirmed by reading its JS source: no HTTP/AJAX fallback anywhere),
 * so it's published directly to the LAN instead (container.ts's `ports`,
 * MOPIDY_PORT bound to 0.0.0.0) and the config panel links straight at
 * that published address, bypassing this proxy and SignalK's own auth for
 * that connection. Revisit if SignalK's plugin API ever exposes the raw
 * server (or a sidecar WS proxy is built) -- the whole reason the
 * built-in web UI this replaced was polling-only in the first place was
 * to route entirely through this proxy without needing that.
 *
 * `fixRequestBody` is required, not optional (confirmed by build-testing
 * against a real devpod): signalk-server's own body-parsing middleware
 * already drains a POST's JSON body before this catch-all `.use()` sees
 * it, so http-proxy would otherwise pipe an already-consumed stream --
 * the target then hangs waiting for body bytes the (correct)
 * Content-Length header promised but that will never arrive. Every GET
 * (no body) proxied fine without it; every POST (Mopidy's /mopidy/rpc,
 * used for all JSON-RPC calls) hung indefinitely.
 */
export function registerMopidyProxy(
  router: RouterLike,
  state: MopidyProxyState,
): void {
  const proxy = createProxyMiddleware({
    router: () => state.address ?? undefined,
    changeOrigin: true,
    on: { proxyReq: fixRequestBody },
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
