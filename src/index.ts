import {
  startSafely,
  resolveMount,
  type RouterLike,
} from "signalk-container-helper";
import {
  createManagedContainer,
  MOPIDY_PORT,
  SNAPCAST_CONTROL_PORT,
  HOST_NETWORKING_ADDRESS,
} from "./container.js";
import { StateStore, createInitialState } from "./state/store.js";
import {
  registerRoutes,
  type SnapserverClientState,
  type SatellitesAppLike,
} from "./routes.js";
import { registerMopidyProxy, type MopidyProxyState } from "./proxy.js";
import { SnapserverClient } from "./snapserver-client.js";
import { startZoneSync, migrateZonesToCurrentJukeboxStream } from "./zone-sync.js";
import { startPlaybackSync } from "./playback-sync.js";
import {
  createLocalSnapclient,
  renameLocalSnapclientZone,
} from "./local-snapclient.js";
import { publishStateChanges, type AppLike } from "./paths.js";
import { MopidyClient } from "./mopidy-client.js";
import {
  registerPlaybackControls,
  registerControlsMeta,
  type ControlsAppLike,
} from "./controls.js";
import {
  registerPlaybackVolumePutHandler,
  registerZonePutHandlers,
  type MopidyClientState,
  type PutHandlerAppLike,
} from "./put-handlers.js";
import {
  SCHEMA_DEFAULTS,
  mergeSettings,
  type PluginSettings,
} from "./types.js";
import { openApiDocument } from "./openapi.js";

// Plugin entry point, following the ManagedContainer archetype
// (signalk-container-helper README "Quick start: a managed container").
// See ARCHITECTURE.md §1-§2 for the full component breakdown; this file is
// mostly wiring -- the real logic lives in state/store.ts,
// container.ts, mopidy-client.ts, snapserver-client.ts, n2k/*, airplay/*.

interface App
  extends AppLike, ControlsAppLike, PutHandlerAppLike, SatellitesAppLike {
  debug(msg: string): void;
  error(msg: string): void;
  getDataDirPath(): string;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  savePluginOptions(options: unknown, cb: () => void): void;
}

export default function plugin(app: App) {
  let container: ReturnType<typeof createManagedContainer> | null = null;
  let localSnapclient: ReturnType<typeof createLocalSnapclient> | null = null;
  let settings: PluginSettings = SCHEMA_DEFAULTS;
  const store = new StateStore(createInitialState());
  let unpublish: (() => void) | null = null;
  let stopZoneSync: (() => void) | null = null;
  let stopPlaybackControls: (() => void) | null = null;
  let stopZonePutHandlers: (() => void) | null = null;
  let stopLocalSnapclientRename: (() => void) | null = null;
  let stopPlaybackSync: (() => void) | null = null;
  // Filled in once container.start() resolves an address (registerWithRouter
  // runs synchronously before that) -- see proxy.ts.
  const proxyState: MopidyProxyState = { address: null };
  // Same pattern, for routes.ts's zone volume/mute/source writes.
  const snapserverState: SnapserverClientState = { client: null };
  // Same pattern again, for put-handlers.ts's playback.volume PUT --
  // registerPlaybackVolumePutHandler runs synchronously in start(), well
  // before container.start() resolves a real MopidyClient to call.
  const mopidyState: MopidyClientState = { client: null };

  const jukebox = {
    id: "signalk-jukebox",
    name: "Jukebox",

    // SignalK does not await start() -- keep it synchronous, let
    // startSafely catch and report async failures (per container-helper
    // convention).
    start(rawConfig: Partial<PluginSettings>) {
      settings = mergeSettings(rawConfig);
      unpublish = publishStateChanges(app, jukebox.id, store);
      // Registered up front, not inside startSafely below: registerPutHandler
      // is a plain app-level registration (like registerWithRouter), not
      // something that needs the container running -- each handler's own
      // "container not ready yet" guard (mopidyState.client /
      // snapserverState.client) covers the gap until it is.
      registerPlaybackVolumePutHandler(app, mopidyState, store);
      stopZonePutHandlers = registerZonePutHandlers(
        app,
        snapserverState,
        store,
      );
      // Meta-only, no value -- makes the controls.* paths discoverable
      // in the Data Browser immediately, rather than only existing once
      // some external source (a pushbutton, a webapp) sends the first
      // real delta (controls.ts's own doc comment).
      registerControlsMeta(app, jukebox.id);

      startSafely(app, async () => {
        let libraryMount: { source: string; containerPath: string } | undefined;
        if (settings.backends.local.enabled && settings.libraryPath) {
          // resolveMount inside startSafely, before buildConfig runs --
          // buildConfig is synchronous and can't await it itself (README
          // "Mounting your plugin's own data directory").
          const { waitForContainerManager } =
            await import("signalk-container-helper");
          const { manager } = await waitForContainerManager();
          if (manager) {
            const resolved = await resolveMount(manager, {
              containerPath: "/music",
              hostPath: settings.libraryPath,
            });
            libraryMount = {
              source: resolved.source,
              containerPath: resolved.containerPath,
            };
          }
        }

        container = createManagedContainer({ app, settings, libraryMount });
        const { address: resolvedAddress } = await container.start(
          settings.imageTag,
        );
        // Under host networking, container.ts omits `readiness` entirely
        // (its own address resolution can't work there -- see that file's
        // doc comment), so `resolvedAddress` is always null in that mode.
        // Substitute the deterministic address instead: sharing the
        // host's network namespace means Mopidy's port simply IS this
        // host's own port, nothing to resolve.
        const address = settings.airplay.hostNetworking
          ? HOST_NETWORKING_ADDRESS
          : resolvedAddress;
        proxyState.address = address;

        // Snapserver's control port is published loopback-only
        // (container.ts's `ports`) specifically for this -- the plugin
        // runs on the same host as the container, never over the LAN.
        // Snapweb (a separate, LAN-published port -- SNAPWEB_PORT) needs
        // no exception here.
        const snapserverClient = new SnapserverClient({
          host: "127.0.0.1",
          port: SNAPCAST_CONTROL_PORT,
        });
        snapserverState.client = snapserverClient;
        stopZoneSync = startZoneSync(store, snapserverClient);
        // One-time: move any zone still on an earlier name for "the
        // jukebox" (this stream has been renamed more than once --
        // zone-sync.ts's own LEGACY_JUKEBOX_STREAM_IDS comment) onto the
        // current MusicAndAlerts stream, so it starts auto-ducking for
        // announcements under the current name. Fire-and-forget -- a
        // failure here doesn't block startup, and the next zone-sync tick
        // just keeps reporting whatever Snapcast actually has.
        void migrateZonesToCurrentJukeboxStream(snapserverClient, (msg) => app.error(msg));

        // The local snapclient's zone starts out named after its raw
        // container hostname (Snapcast's own fallback when no name has
        // been set) -- give it the configured human-readable name once
        // it actually connects. Runs against the MAIN container's
        // Snapserver (the only one with a control API), independent of
        // the local-snapclient container's own startSafely below.
        if (settings.localSnapclient.enabled) {
          stopLocalSnapclientRename = renameLocalSnapclientZone(
            snapserverClient,
            settings.localSnapclient.zoneName,
          );
        }

        // address is non-null here either way: readiness resolves one when
        // configured (the normal case), and HOST_NETWORKING_ADDRESS is a
        // fixed literal otherwise -- guarded anyway since the type is
        // nullable.
        if (address) {
          mopidyState.client = new MopidyClient({ baseUrl: address });
          stopPlaybackControls = registerPlaybackControls(
            app,
            mopidyState.client,
          );
          stopPlaybackSync = startPlaybackSync(store, mopidyState.client);
        }

        // TODO(implementation): if settings.n2k.enabled, construct
        // FusionAdapter/EntertainmentPgnAdapter (n2k/fusion.ts,
        // n2k/entertainment-pgn.ts) and subscribe them to store changes.
        // TODO(implementation): if settings.airplay.enabled, provision the
        // AirPlay slot pool (airplay/pool.ts) against the running
        // Snapserver.

        app.setPluginStatus(`Running on port ${MOPIDY_PORT}`);
      });

      // Separate startSafely, not nested inside the one above: a local
      // snapclient failing to start (e.g. a bad soundCard string) must
      // surface its own error, not take the whole plugin down with it --
      // the main jukebox container and every other zone are unaffected
      // either way (SPEC.md §9, §12).
      if (settings.localSnapclient.enabled) {
        localSnapclient = createLocalSnapclient({
          app,
          local: settings.localSnapclient,
        });
        startSafely(app, () => localSnapclient!.start());
      }
    },

    async stop() {
      unpublish?.();
      unpublish = null;
      stopZoneSync?.();
      stopZoneSync = null;
      stopPlaybackControls?.();
      stopPlaybackControls = null;
      stopPlaybackSync?.();
      stopPlaybackSync = null;
      stopZonePutHandlers?.();
      stopZonePutHandlers = null;
      stopLocalSnapclientRename?.();
      stopLocalSnapclientRename = null;
      snapserverState.client = null;
      mopidyState.client = null;
      proxyState.address = null;
      await container?.stop(); // unregister updates + stop, never throws
      await localSnapclient?.stop();
      localSnapclient = null;
      app.setPluginStatus("Stopped");
    },

    registerWithRouter(router: RouterLike) {
      registerRoutes({
        router,
        store,
        snapserver: snapserverState,
        app,
      });

      container?.registerUpdateRoutes(router, {
        onApplied: (requestedTag) => {
          settings.imageTag = requestedTag;
          app.savePluginOptions(settings, () => undefined);
        },
      });

      // Catch-all -- must be registered last, after every specific route
      // above (proxy.ts).
      registerMopidyProxy(router, proxyState);
    },

    // Standard SignalK plugin hook (@signalk/server-api's Plugin
    // interface) -- documents this plugin's REST API (SPEC.md §6.1) in
    // the server's own OpenAPI explorer alongside every other plugin's
    // API, per its own doc comment recommending this for any plugin that
    // provides one.
    getOpenApi: () => openApiDocument,

    schema: () => ({
      type: "object",
      properties: {
        libraryPath: {
          type: "string",
          title: "Music library path (host folder)",
        },
        backends: {
          type: "object",
          properties: {
            local: {
              type: "object",
              properties: {
                enabled: {
                  type: "boolean",
                  default: true,
                  title: "Enable local library",
                },
              },
            },
            radio: {
              type: "object",
              properties: {
                enabled: {
                  type: "boolean",
                  default: false,
                  title: "Enable internet radio",
                },
              },
            },
            spotify: {
              type: "object",
              properties: {
                enabled: {
                  type: "boolean",
                  default: false,
                  title:
                    "Enable Spotify (currently degraded upstream -- see SPEC.md §5, §13)",
                },
                clientId: { type: "string", title: "Spotify client ID" },
                clientSecret: {
                  type: "string",
                  title: "Spotify client secret",
                },
              },
            },
          },
        },
        imageTag: { type: "string", default: "auto", title: "Image version" },
        n2k: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              default: false,
              title: "Enable NMEA2000 / Fusion-Link",
            },
            deviceName: { type: "string", default: "Jukebox" },
            deviceInstance: { type: "number", default: 0 },
          },
        },
        airplay: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              default: true,
              title: "Enable AirPlay zones",
            },
            namePattern: { type: "string", default: "{boatName} - {zoneName}" },
            hostNetworking: {
              type: "boolean",
              default: false,
              title:
                "Run container with host networking (required for AirPlay discovery -- see the config panel for details)",
            },
          },
        },
        vhf: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              default: true,
              title: "Pause playback on VHF radio traffic",
            },
            resumeDelaySeconds: { type: "number", default: 5 },
          },
        },
        voiceDucking: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              default: true,
              title: "Duck volume during voice-assistant activity",
            },
            duckVolumePercent: { type: "number", default: 20 },
            resumeDelaySeconds: { type: "number", default: 1 },
            satelliteZoneMap: {
              type: "array",
              title:
                "Per-satellite zone mapping (optional -- unmapped satellites duck all zones)",
              items: {
                type: "object",
                properties: {
                  satelliteId: {
                    type: "string",
                    title: "voice.satellites.<id>",
                  },
                  zoneId: { type: "string", title: "Jukebox zone id" },
                },
              },
            },
          },
        },
        localSnapclient: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              default: false,
              title:
                "Run a local Snapclient zone on this SignalK server's own sound card",
            },
            soundCard: {
              type: "string",
              title:
                'ALSA device (required when enabled, e.g. "plughw:CARD=wm8960soundcard,DEV=0" -- see this host\'s `aplay -L` output)',
            },
            zoneName: {
              type: "string",
              default: "Local speakers",
              title: "Zone name",
            },
            tag: { type: "string", default: "auto", title: "Image version" },
          },
        },
      },
    }),
  };

  return jukebox;
}
