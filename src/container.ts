import {
  ManagedContainer,
  type ManagedContainerOptions,
} from "signalk-container-helper";
import type { PluginSettings } from "./types.js";

// The custom signalk-jukebox container image (ARCHITECTURE.md §2.4): Mopidy
// + Iris + Snapserver (with its statically pre-provisioned AirPlay stream
// pool, SPEC.md §6.4) in one image, built from image/Dockerfile.
//
// TODO(image): image/Dockerfile does not exist yet -- this points at a
// placeholder repository until the image is built and published per
// ARCHITECTURE.md §8.
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
      // Mopidy HTTP/JSON-RPC + Iris web client, reverse-proxied by the
      // plugin (ARCHITECTURE.md §2.2); Snapcast stream/control ports are
      // not exposed to signalkAccessiblePorts -- they're LAN-facing, not
      // routed through the SK server (SPEC.md §6, security note).
      signalkAccessiblePorts: [MOPIDY_PORT],
      env: {
        JUKEBOX_LOCAL_ENABLED: String(settings.backends.local.enabled),
        JUKEBOX_RADIO_ENABLED: String(settings.backends.radio.enabled),
        JUKEBOX_SPOTIFY_ENABLED: String(settings.backends.spotify.enabled),
        JUKEBOX_SPOTIFY_USERNAME: settings.backends.spotify.username ?? "",
        JUKEBOX_SPOTIFY_PASSWORD: settings.backends.spotify.password ?? "",
        JUKEBOX_AIRPLAY_MAX_ZONES: String(settings.airplay.maxZones),
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
