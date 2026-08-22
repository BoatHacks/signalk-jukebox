import {
  ManagedContainer,
  type ManagedContainerOptions,
} from "signalk-container-helper";
import type { PluginSettings } from "./types.js";

// The custom signalk-jukebox container image (ARCHITECTURE.md §2.4): Mopidy
// + a minimal built-in web UI + Snapserver in one image, built from
// image/Dockerfile (build-tested; see that file's header for why Mopidy-Iris
// isn't used -- incompatible with the Mopidy 4.x this image needs). Snapserver
// is pinned >= 0.33.0 so the plugin can create/remove per-zone airplay
// streams at runtime (SPEC.md §6.4, §13) -- no static AirPlay stream pool to
// configure here.
//
// TODO(image): not yet published -- this points at a placeholder registry
// path until the image is built and pushed per ARCHITECTURE.md §8.
export const JUKEBOX_IMAGE = "ghcr.io/boathacks/signalk-jukebox";

export const MOPIDY_PORT = 6680;

export interface CreateManagedContainerArgs {
  app: ManagedContainerOptions["app"];
  settings: PluginSettings;
  /** Resolved host mount for the music library, if the local backend is
   * enabled (SPEC.md §5, §9) -- caller resolves this via resolveMount()
   * before calling in, per signalk-container-helper's README guidance on
   * resolving mounts inside startSafely, before buildConfig runs. */
  libraryMount?: { source: string; containerPath: string };
}

export function createManagedContainer({
  app,
  settings,
  libraryMount,
}: CreateManagedContainerArgs): ManagedContainer {
  return new ManagedContainer({
    app,
    pluginId: "signalk-jukebox",
    name: "jukebox",
    image: JUKEBOX_IMAGE,
    defaultTag: "latest",
    buildConfig: (tag) => ({
      image: JUKEBOX_IMAGE,
      tag,
      // Mopidy HTTP/JSON-RPC + the minimal built-in web UI (image/webui),
      // reverse-proxied by the plugin (ARCHITECTURE.md §2.2); Snapcast
      // stream/control ports are not exposed to signalkAccessiblePorts --
      // they're LAN-facing, not routed through the SK server (SPEC.md §6,
      // security note).
      signalkAccessiblePorts: [MOPIDY_PORT],
      env: {
        JUKEBOX_LOCAL_ENABLED: String(settings.backends.local.enabled),
        JUKEBOX_RADIO_ENABLED: String(settings.backends.radio.enabled),
        JUKEBOX_SPOTIFY_ENABLED: String(settings.backends.spotify.enabled),
        // clientId/clientSecret, not username/password -- Spotify disabled
        // third-party username/password login entirely; SPEC.md §5, §13.
        JUKEBOX_SPOTIFY_CLIENT_ID: settings.backends.spotify.clientId ?? "",
        JUKEBOX_SPOTIFY_CLIENT_SECRET:
          settings.backends.spotify.clientSecret ?? "",
      },
      volumes: libraryMount ? { "/music": libraryMount.source } : undefined,
      restart: "unless-stopped",
      resources: {
        cpus: 1,
        memory: "512m",
        memorySwap: "512m",
        pidsLimit: 200,
      },
    }),
    readiness: { port: MOPIDY_PORT, path: "/mopidy/rpc" },
  });
}
