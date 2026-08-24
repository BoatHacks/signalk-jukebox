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
  registerPlaybackControlPutHandlers,
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
import { FusionAdapter, FUSION_REFRESH_INTERVAL_MS, type FusionAppLike } from "./n2k/fusion.js";
import { applyFusionCommand } from "./n2k/apply-command.js";
import {
  loadZoneAssignments,
  saveZoneAssignments,
} from "./state/zone-assignments-file.js";

// Plugin entry point, following the ManagedContainer archetype
// (signalk-container-helper README "Quick start: a managed container").
// See ARCHITECTURE.md §1-§2 for the full component breakdown; this file is
// mostly wiring -- the real logic lives in state/store.ts,
// container.ts, mopidy-client.ts, snapserver-client.ts, n2k/*, airplay/*.

interface App
  extends AppLike,
    ControlsAppLike,
    PutHandlerAppLike,
    SatellitesAppLike,
    FusionAppLike {
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
  let fusionAdapter: FusionAdapter | null = null;
  let stopFusionBroadcast: (() => void) | null = null;
  let fusionRefreshTimer: NodeJS.Timeout | null = null;
  let stopFusionIncoming: (() => void) | null = null;
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
      // Same "up front" reasoning as the volume handler above -- also
      // what makes entertainment.jukebox.playback.controls.* answer a
      // real SignalK PUT request at all, and publishes their
      // `supportsPut: true` meta as a side effect of registering
      // (put-handlers.ts's own doc comment on this function).
      registerPlaybackControlPutHandlers(app, mopidyState);
      stopZonePutHandlers = registerZonePutHandlers(
        app,
        snapserverState,
        store,
      );
      // Publishes description meta + an initial value (0, released) for
      // the controls.* paths, so they show up in the Data Browser / any
      // path picker immediately rather than only existing once something
      // first presses one (controls.ts's own doc comment) -- independent
      // of registerPlaybackControlPutHandlers above, which separately
      // adds their supportsPut meta.
      registerControlsMeta(app, jukebox.id);

      startSafely(app, async () => {
        // resolveMount inside startSafely, before buildConfig runs --
        // buildConfig is synchronous and can't await it itself (README
        // "Mounting your plugin's own data directory").
        const { waitForContainerManager } =
          await import("signalk-container-helper");
        const { manager } = await waitForContainerManager();

        let libraryMount: { source: string; containerPath: string } | undefined;
        if (manager && settings.backends.local.enabled && settings.libraryPath) {
          const resolved = await resolveMount(manager, {
            containerPath: "/music",
            hostPath: settings.libraryPath,
          });
          libraryMount = {
            source: resolved.source,
            containerPath: resolved.containerPath,
          };
        }

        // Unconditional (unlike libraryMount above): this is where
        // Mopidy's own data + Snapserver's server.json persist across a
        // real container recreate, not just the music library -- see
        // container.ts's own CreateManagedContainerArgs.dataMount comment.
        let dataMount: { source: string; containerPath: string } | undefined;
        if (manager) {
          const resolved = await resolveMount(manager, {
            containerPath: "/data",
            hostPath: app.getDataDirPath(),
          });
          dataMount = {
            source: resolved.source,
            containerPath: resolved.containerPath,
          };
        }

        container = createManagedContainer({
          app,
          settings,
          libraryMount,
          dataMount,
        });
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

        // Restore each zone's permanent n2kZone slot (SPEC.md §2, §8)
        // before zone-sync's first tick runs, so a zone seen again after
        // a restart gets its existing slot back rather than looking
        // "new" and claiming another one. A read failure here (anything
        // but "nothing persisted yet") isn't fatal -- every zone just
        // re-claims a slot as if seen for the first time, same as a
        // corrupt file would already fall back to inside
        // loadZoneAssignments itself.
        try {
          const persistedAssignments = await loadZoneAssignments(
            app.getDataDirPath(),
          );
          store.restoreZoneAssignments(persistedAssignments);
        } catch (err) {
          app.error(
            `signalk-jukebox: could not load persisted zone assignments: ${String(err)}`,
          );
        }

        stopZoneSync = startZoneSync(store, snapserverClient, undefined, () => {
          // Fire-and-forget: a save failure is logged, not fatal -- the
          // in-memory claim (store.setZoneAssignment, already applied
          // before this callback runs) still holds for the rest of this
          // session either way, it just wouldn't survive a restart.
          void saveZoneAssignments(
            app.getDataDirPath(),
            store.getPersistedZoneAssignments(),
          ).catch((err: unknown) => {
            app.error(
              `signalk-jukebox: could not persist zone assignment: ${String(err)}`,
            );
          });
        });
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

        // entertainment-pgn.ts (the generic/standard NMEA2000 Entertainment
        // PGN set, SPEC.md §6.3's secondary surface) stays unwired for now
        // -- its own file header notes real-world chartplotter coverage is
        // unverified, possibly not worth maintaining at all; Fusion-Link
        // below is the primary, better-evidenced surface.
        if (settings.n2k.enabled) {
          const adapter = new FusionAdapter({
            deviceName: settings.n2k.deviceName,
            app,
          });
          fusionAdapter = adapter;

          const broadcast = () => {
            adapter.broadcastState(store.getPlayback(), store.getZones());
          };

          // On every canonical-state change (SPEC.md §6.3's primary
          // trigger)...
          store.onChange(broadcast);
          stopFusionBroadcast = () => store.offChange(broadcast);

          // ...plus a periodic refresh regardless, so a device joining the
          // bus mid-session still gets current state without waiting for
          // an actual change (fusion.ts's own FUSION_REFRESH_INTERVAL_MS
          // doc comment).
          fusionRefreshTimer = setInterval(broadcast, FUSION_REFRESH_INTERVAL_MS);

          // ...plus immediately in response to a real MFD explicitly
          // asking for one (PGN_126720_FusionRequestStatus, decoded below
          // to "requestStatus") -- more responsive than waiting out the
          // periodic refresh for that specific, common case.
          const incomingListener = (pgn: unknown) => {
            for (const command of adapter.decodeIncoming(pgn)) {
              void applyFusionCommand(command, {
                mopidy: mopidyState.client,
                snapserver: snapserverState.client,
                store,
                onError: (msg) => app.error(msg),
                onRequestStatus: broadcast,
              });
            }
          };
          app.on?.("N2KAnalyzerOut", incomingListener);
          stopFusionIncoming = () =>
            app.off?.("N2KAnalyzerOut", incomingListener);

          // No real ISO Address Claim happens (SPEC.md §6.3, §13's own
          // bus-identity caveat -- broadcasts ride SignalK's own already-
          // claimed address, not a distinct one this plugin negotiates for
          // itself), so "claimed" here means "the Fusion interface is
          // active and broadcasting," not a literal NMEA2000 address
          // claim negotiation. That negotiation not happening at all is
          // exactly the accepted, documented scope decision -- this is
          // just the state's honest label for the resulting condition.
          store.setN2kDeviceState("claimed");

          broadcast(); // don't wait for the first change/timer tick
        }
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
      stopFusionBroadcast?.();
      stopFusionBroadcast = null;
      stopFusionIncoming?.();
      stopFusionIncoming = null;
      if (fusionRefreshTimer) clearInterval(fusionRefreshTimer);
      fusionRefreshTimer = null;
      fusionAdapter = null;
      store.setN2kDeviceState("unclaimed");
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
