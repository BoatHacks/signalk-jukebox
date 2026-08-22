import {
  startSafely,
  resolveMount,
  type RouterLike,
} from "signalk-container-helper";
import { createManagedContainer, MOPIDY_PORT } from "./container.js";
import { StateStore, createInitialState } from "./state/store.js";
import { registerRoutes } from "./routes.js";
import { publishStateChanges, type AppLike } from "./paths.js";
import { SCHEMA_DEFAULTS, type PluginSettings } from "./types.js";

// Plugin entry point, following the ManagedContainer archetype
// (signalk-container-helper README "Quick start: a managed container").
// See ARCHITECTURE.md §1-§2 for the full component breakdown; this file is
// mostly wiring -- the real logic lives in state/store.ts,
// container.ts, mopidy-client.ts, snapserver-client.ts, n2k/*, airplay/*.

interface App extends AppLike {
  debug(msg: string): void;
  getDataDirPath(): string;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  savePluginOptions(options: unknown, cb: () => void): void;
}

export default function plugin(app: App) {
  let container: ReturnType<typeof createManagedContainer> | null = null;
  let settings: PluginSettings = SCHEMA_DEFAULTS;
  const store = new StateStore(createInitialState());
  let unpublish: (() => void) | null = null;

  const jukebox = {
    id: "signalk-jukebox",
    name: "Jukebox",

    // SignalK does not await start() -- keep it synchronous, let
    // startSafely catch and report async failures (per container-helper
    // convention).
    start(rawConfig: Partial<PluginSettings>) {
      settings = { ...SCHEMA_DEFAULTS, ...rawConfig };
      unpublish = publishStateChanges(app, jukebox.id, store);

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
        const { address } = await container.start(settings.imageTag);
        void address; // base URL for the Mopidy/Iris reverse proxy (TODO below)

        // TODO(implementation): reverse-proxy Iris/Mopidy's web UI at this
        // plugin's path using `address`, and wire up mopidy-client.ts /
        // snapserver-client.ts polling loops that feed the StateStore --
        // this is the next layer to build once the container image
        // (ARCHITECTURE.md §2.4, image/Dockerfile) exists to test against.

        // TODO(implementation): if settings.n2k.enabled, construct
        // FusionAdapter/EntertainmentPgnAdapter (n2k/fusion.ts,
        // n2k/entertainment-pgn.ts) and subscribe them to store changes.
        // TODO(implementation): if settings.airplay.enabled, provision the
        // AirPlay slot pool (airplay/pool.ts) against the running
        // Snapserver.

        app.setPluginStatus(`Running on port ${MOPIDY_PORT}`);
      });
    },

    async stop() {
      unpublish?.();
      unpublish = null;
      await container?.stop(); // unregister updates + stop, never throws
      app.setPluginStatus("Stopped");
    },

    registerWithRouter(router: RouterLike) {
      registerRoutes({
        router,
        store,
        // TODO: real SnapserverClient once the container is reachable --
        // routes.ts needs one to apply zone volume/mute writes.
        snapserver: undefined as never,
      });

      container?.registerUpdateRoutes(router, {
        onApplied: (requestedTag) => {
          settings.imageTag = requestedTag;
          app.savePluginOptions(settings, () => undefined);
        },
      });
    },

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
              type: "object",
              title: "voice.satellites.<id> -> zone id (optional)",
              additionalProperties: { type: "string" },
            },
          },
        },
      },
    }),
  };

  return jukebox;
}
