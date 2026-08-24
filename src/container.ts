import {
  ManagedContainer,
  type ManagedContainerOptions,
  type ContainerConfig,
} from "signalk-container-helper";
import type { PluginSettings } from "./types.js";

// The custom signalk-jukebox container image (ARCHITECTURE.md §2.4): Mopidy
// + Mopidy-MusicBox-Webclient + Snapserver in one image, built from
// image/Dockerfile (build-tested; see that file's header for why Mopidy-Iris
// isn't used -- incompatible with the Mopidy 4.x this image needs, and for
// why Mopidy-MusicBox-Webclient needs a setuptools<80 pin). Snapserver
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
/** Snapweb (image/Dockerfile), served by Snapserver's genuinely
 * HTTP-capable `[http]` server -- deliberately a different port than
 * SNAPCAST_CONTROL_PORT above. Confirmed by build-testing: Snapserver's
 * `[tcp-control]`-equivalent raw-socket protocol and its real HTTP server
 * are separate listeners under the hood, and putting both on the same
 * port made the real one behave like the raw one (no HTTP parsing, no
 * static files) -- see snapserver.conf.template's own note. */
export const SNAPWEB_PORT = 1780;
/** Announcement intake stream (snapserver.conf.template's `[stream]`
 * section, `tcp server` source type, ALERTS_STREAM_ID = "Alerts") -- any
 * other container/process can connect here and stream a WAV-framed
 * announcement, and a zone can be manually switched onto it (src/
 * routes.ts's /source endpoint) instead of being muted entirely, so it
 * stays reachable for announcements while off the jukebox stream.
 * Snapcast's own real default port for this source type. */
export const ALERTS_PORT = 4953;
export const ALERTS_STREAM_ID = "Alerts";

/** The container's address once `airplay.hostNetworking` is on: sharing
 * the host's network namespace directly means Mopidy's port literally
 * IS this host's own port, with no podman/docker translation to resolve
 * -- see createManagedContainer's own doc comment for why this can't go
 * through signalk-container-helper's normal address resolution. */
export const HOST_NETWORKING_ADDRESS = `http://127.0.0.1:${MOPIDY_PORT}`;

export interface CreateManagedContainerArgs {
  app: ManagedContainerOptions["app"];
  settings: PluginSettings;
  /** Resolved host mount for the music library, if the local backend is
   * enabled (SPEC.md §5, §9) -- caller resolves this via resolveMount()
   * before calling in, per signalk-container-helper's README guidance on
   * resolving mounts inside startSafely, before buildConfig runs. */
  libraryMount?: { source: string; containerPath: string };
  /** Resolved host mount for this plugin's own persistent data dir
   * (app.getDataDirPath(), via resolveMount() same as libraryMount) --
   * mounted at /data, where Mopidy's own data_dir and Snapserver's datadir
   * (mopidy.conf.template, snapserver.conf.template) both already live.
   * Without this, server.json (Snapcast's client/group registration,
   * volume, mute, and each zone's current stream assignment) sat in the
   * container's own ephemeral layer, confirmed lost on every real
   * container recreate (not just a plain restart of the same container),
   * as was Mopidy's own Spotify auth cache and library scan cache. */
  dataMount?: { source: string; containerPath: string };
}

/** Full ContainerConfig for a tag (pure -- unit-tested directly, same
 * shape as local-snapclient.ts's own buildLocalSnapclientConfig). */
export function buildJukeboxConfig(
  tag: string,
  settings: PluginSettings,
  libraryMount?: { source: string; containerPath: string },
  dataMount?: { source: string; containerPath: string },
): ContainerConfig {
  const hostNetworking = settings.airplay.hostNetworking;
  return {
    image: JUKEBOX_IMAGE,
    tag,
    // Mopidy HTTP/JSON-RPC + Mopidy-MusicBox-Webclient (image/Dockerfile,
    // ARCHITECTURE.md §2.4) run on MOPIDY_PORT. signalkAccessiblePorts binds
    // it loopback-only, on a host port signalk-container-helper picks
    // dynamically (confirmed by reading signalk-container-helper's own
    // types: the resulting binding is 127.0.0.1:<dynamic>, resolved after
    // the fact via `resolveContainerAddress`) -- this plugin's OWN internal
    // MopidyClient (index.ts) and the readiness prober below use that.
    // It's deliberately NOT how the web client itself is reached: see the
    // `ports` entry below instead, a second, independent, FIXED-host-port
    // binding of the same container port for that.
    //
    // Omitted entirely under host networking: confirmed against a real
    // production instance that signalk-container discards `networkMode`
    // outright the moment `signalkAccessiblePorts` is also set (its own
    // warning: "signalkAccessiblePorts and networkMode are both set --
    // 'host' will be discarded") -- silently falling back to bridge
    // mode. That meant this container was ALWAYS running in bridge
    // mode even with `airplay.hostNetworking` turned on, while `ports`
    // below was ALSO omitted (since the code assumed host networking
    // was actually applying) -- neither mechanism ever actually
    // published anything, breaking Snapcast connectivity entirely.
    signalkAccessiblePorts: hostNetworking ? undefined : [MOPIDY_PORT],
    // Real LAN-facing publishing (SPEC.md §6, security note): the
    // stream port is bound to every interface so physical Snapclients
    // elsewhere on the boat LAN can actually reach it -- confirmed by
    // testing that omitting this entirely (the previous state of this
    // file) left Snapcast reachable only from this same host, not the
    // LAN, despite the docs already describing the intended LAN-facing
    // design.
    //
    // The control port stays loopback-only: only this plugin's own
    // SnapserverClient (running on this same host) needs it, and it has
    // no authentication of its own (SPEC.md §6) to justify wider
    // exposure. Snapweb needs no exception here -- it's served on its
    // own separate SNAPWEB_PORT below, not this one (see that constant's
    // own comment for why they can't share a port).
    //
    // SNAPWEB_PORT and MOPIDY_PORT ARE bound to every interface, for the
    // same reason each: their web clients (Snapweb; Mopidy-MusicBox-
    // Webclient) run entirely over a WebSocket, and this plugin's own
    // reverse proxy (proxy.ts) can't forward a WS upgrade at all (no
    // access to the raw http.Server via registerWithRouter's Express
    // Router -- confirmed against SignalK's plugin API and
    // signalk-container-helper's types, neither exposes one). The only
    // way the browser's WS connection actually completes is a direct
    // connection to the container's own port, bypassing SignalK's proxy
    // and its auth entirely. Accepted trade-off (SPEC.md §6 security
    // note): neither Snapserver's control API nor Mopidy has any auth of
    // its own either way, but these bindings are now reachable from the
    // whole LAN, not just this host -- whoever asked for this chose that
    // explicitly, after confirming signalk-server's plugin API, the
    // loopback-only signalkAccessiblePorts mechanism, and this plugin's
    // own reverse proxy all have no WS-proxying path.
    //
    // ALERTS_PORT is bound to every interface for a different reason:
    // it's an intentional intake, meant to be reachable by other
    // containers/processes wanting to stream an announcement in (its own
    // comment, and SNAPWEB_PORT's above, cover why Snapcast's ports have
    // no auth to lose either way).
    // `ports` is ignored once `networkMode` is set (signalk-container-
    // helper's own type docs), so only declare it when NOT using host
    // networking; under host networking every port here is already the
    // host's own port with no publishing needed at all.
    ports: hostNetworking
      ? undefined
      : {
          [`${SNAPCAST_STREAM_PORT}/tcp`]: `0.0.0.0:${SNAPCAST_STREAM_PORT}`,
          [`${SNAPCAST_CONTROL_PORT}/tcp`]: `127.0.0.1:${SNAPCAST_CONTROL_PORT}`,
          [`${SNAPWEB_PORT}/tcp`]: `0.0.0.0:${SNAPWEB_PORT}`,
          [`${ALERTS_PORT}/tcp`]: `0.0.0.0:${ALERTS_PORT}`,
          [`${MOPIDY_PORT}/tcp`]: `0.0.0.0:${MOPIDY_PORT}`,
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
    networkMode: hostNetworking ? "host" : undefined,
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
    volumes:
      libraryMount || dataMount
        ? {
            ...(libraryMount ? { "/music": libraryMount.source } : {}),
            ...(dataMount ? { "/data": dataMount.source } : {}),
          }
        : undefined,
    restart: "unless-stopped",
    resources: {
      cpus: 1,
      memory: "512m",
      memorySwap: "512m",
      pidsLimit: 200,
    },
  };
}

export function createManagedContainer({
  app,
  settings,
  libraryMount,
  dataMount,
}: CreateManagedContainerArgs): ManagedContainer {
  const hostNetworking = settings.airplay.hostNetworking;
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
    // Default 120_000ms (signalk-container-helper's own default) is far
    // longer than signalk-container actually needs to register its global
    // in real use (both plugins start together at server boot) -- and it's
    // long enough to break SignalK's plugin-ci lifecycle check, confirmed
    // by build-testing: that harness's mock server has no signalk-container
    // at all, so `stop()` (which waits out any in-flight `start()`) blocks
    // for the full budget before the harness's own 2-minute step timeout
    // can be safely cleared, given the check calls start/stop/start/stop
    // in sequence. 20s is still generous for the real case and leaves
    // comfortable headroom under that 2-minute ceiling for the genuinely-
    // absent case (CI, or a misconfigured install).
    managerTimeoutMs: 20_000,
    buildConfig: (tag) =>
      buildJukeboxConfig(tag, settings, libraryMount, dataMount),
    // Confirmed by build-testing (devpod): /mopidy/rpc is POST-only
    // JSON-RPC and returns 405 to a plain GET, which is what
    // signalk-container-helper's readiness prober sends -- using it here
    // meant the container never registered as ready, container.start()
    // never resolved an address, and the reverse proxy (proxy.ts) stayed
    // permanently 503. Mopidy-MusicBox-Webclient's own static index
    // (always mounted, §2.4) answers GET with a real 200 and needs no
    // JSON body -- pointed at the file directly (not the bare
    // "/musicbox_webclient/" path, which 301-redirects to it; confirmed
    // by build-testing that the redirect target itself, not the
    // redirect, is what actually returns 200).
    //
    // Omitted entirely under host networking: ManagedContainer's own
    // address resolution (resolveAddress, signalk-container-helper's
    // internals) needs either `signalkAccessiblePorts` or a parseable
    // published-port entry from listContainers() -- neither exists once
    // this container actually shares the host's network namespace (there
    // is nothing "published"; the process just binds the real host port
    // directly). Confirmed: with `signalkAccessiblePorts` omitted above,
    // readiness's own resolveAddress would return null and
    // container.start() would reject outright ("address-unresolved"),
    // taking the whole plugin down. index.ts instead uses the always-true
    // HOST_NETWORKING_ADDRESS directly in this mode -- deterministic,
    // since sharing the host's network stack means Mopidy's port simply
    // IS this host's own port, nothing to resolve.
    readiness: hostNetworking
      ? undefined
      : { port: MOPIDY_PORT, path: "/musicbox_webclient/index.html" },
  });
}
