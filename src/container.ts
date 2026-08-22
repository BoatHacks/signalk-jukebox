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
// Published (ARCHITECTURE.md §8): ghcr.io/boathacks/signalk-jukebox:latest
// and :0.0.1, public visibility.
export const JUKEBOX_IMAGE = "ghcr.io/boathacks/signalk-jukebox";

export const MOPIDY_PORT = 6680;
export const SNAPCAST_STREAM_PORT = 1704;
export const SNAPCAST_CONTROL_PORT = 1705;

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
    // "auto" (SCHEMA_DEFAULTS.imageTag, §9) is a settings-level sentinel
    // meaning "track the latest published version" -- signalk-container-
    // helper's own README documents that `resolveTag` is required to turn
    // it into a real tag before it reaches podman. Confirmed the hard way
    // (devpod testing): without this, "auto" is passed straight through
    // as a literal tag, and `podman pull ...:auto` 404s (no such tag was
    // ever published).
    resolveTag: (requested) => (requested === "auto" ? "latest" : requested),
    buildConfig: (tag) => ({
      image: JUKEBOX_IMAGE,
      tag,
      // Mopidy HTTP/JSON-RPC + the minimal built-in web UI (image/webui),
      // reverse-proxied by the plugin (ARCHITECTURE.md §2.2). Snapcast's
      // ports are NOT declared here -- signalkAccessiblePorts is a
      // different, loopback-only mechanism (confirmed by reading
      // signalk-container-helper's own types: the resulting host binding
      // is 127.0.0.1, for signalk-server's own proxying use, per
      // `resolveContainerAddress`) that would not make Snapcast reachable
      // from the LAN even if listed here. See `ports` below instead.
      signalkAccessiblePorts: [MOPIDY_PORT],
      // Real LAN-facing publishing (SPEC.md §6, security note): the
      // stream port is bound to every interface so physical Snapclients
      // elsewhere on the boat LAN can actually reach it -- confirmed by
      // testing that omitting this entirely (the previous state of this
      // file) left Snapcast reachable only from this same host, not the
      // LAN, despite the docs already describing the intended LAN-facing
      // design. The control port stays loopback-only: only this plugin's
      // own SnapserverClient (running on this same host) needs it, and it
      // has no authentication of its own (SPEC.md §6) to justify wider
      // exposure.
      // `ports` is ignored once `networkMode` is set (signalk-container-
      // helper's own type docs), so only declare it when NOT using host
      // networking.
      ports: settings.airplay.hostNetworking
        ? undefined
        : {
            [`${SNAPCAST_STREAM_PORT}/tcp`]: `0.0.0.0:${SNAPCAST_STREAM_PORT}`,
            [`${SNAPCAST_CONTROL_PORT}/tcp`]: `127.0.0.1:${SNAPCAST_CONTROL_PORT}`,
          },
      // AirPlay discovery (mDNS) and each per-zone receiver's own
      // dynamically-chosen RTSP/RTP ports don't traverse the bridge/NAT
      // boundary the container otherwise runs under, and there's no fixed
      // port list to publish the way Snapcast's stream port can be, since
      // shairport-sync instances are created per zone on demand (§6.4) --
      // confirmed by build-testing. Host networking removes that boundary
      // entirely, at the cost of sharing the host's network namespace and
      // port space with every other process on it. Opt-in
      // (`airplay.hostNetworking`, §9), default off.
      networkMode: settings.airplay.hostNetworking ? "host" : undefined,
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
    // Confirmed by build-testing (devpod): /mopidy/rpc is POST-only
    // JSON-RPC and returns 405 to a plain GET, which is what
    // signalk-container-helper's readiness prober sends -- using it here
    // meant the container never registered as ready, container.start()
    // never resolved an address, and the reverse proxy (proxy.ts) stayed
    // permanently 503. image/webui's own static index (always mounted,
    // §2.4) answers GET with a real 200 and needs no JSON body.
    readiness: { port: MOPIDY_PORT, path: "/jukebox/" },
  });
}
