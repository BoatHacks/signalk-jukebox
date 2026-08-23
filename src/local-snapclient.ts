import {
  ManagedContainer,
  type ContainerConfig,
} from "signalk-container-helper";
import { SNAPCAST_STREAM_PORT } from "./container.js";

// Local snapclient (SPEC.md §9, §12; ARCHITECTURE.md §2.4) -- an optional
// second ManagedContainer, running signalk-jukebox's own minimal
// `ghcr.io/boathacks/signalk-jukebox-snapclient` image, for a boat with
// speakers wired directly to the SignalK server's own machine rather than
// (or in addition to) a separate physical Snapclient device. Modeled
// directly on signalk-wyoming's local-satellite.ts, which solves the same
// "run a companion container alongside the main one, on this same host"
// problem for its own local microphone/speaker.

export const LOCAL_SNAPCLIENT_IMAGE =
  "ghcr.io/boathacks/signalk-jukebox-snapclient";
export const LOCAL_SNAPCLIENT_CONTAINER_NAME = "jukebox-snapclient";

/** Fixed Snapcast client id (image-snapclient/entrypoint.sh's --hostID),
 * NOT the display name -- confirmed by hand that --hostID only overrides
 * `client.id`, not `client.host.name` (the fallback Snapcast shows when
 * no name has been set, e.g. "16684a3df93c", a podman-assigned container
 * hostname). Fixing this id is what lets renameLocalSnapclientZone find
 * "the" local snapclient's zone deterministically -- there is always
 * exactly one per plugin instance. */
export const LOCAL_SNAPCLIENT_HOST_ID = "jukebox-local-snapclient";

/** In-container alias for the Signal K host (extraHosts host-gateway) --
 * the same mechanism signalk-wyoming's local-satellite.ts uses to reach
 * the host reliably. Confirmed needed by hand: connecting a separate
 * container to the main jukebox container via a raw LAN IP or shared
 * network namespace was unreliable under this project's actual rootless-
 * Podman (pasta) test host, while `host-gateway` -- a purpose-built
 * Docker/Podman mechanism for exactly "let this container reach the
 * host" -- is not subject to the same routing quirks. */
export const SK_HOST_ALIAS = "skhost";

export interface LocalSnapclientConfig {
  enabled: boolean;
  /** ALSA device string, e.g. "plughw:CARD=wm8960soundcard,DEV=0" -- see
   * this host's own `aplay -L` output. Required when enabled; there is
   * deliberately no "auto"/default fallback (SPEC.md §12): a bare
   * "default" ALSA device is ambiguous and failed outright on a host
   * with more than one sound card, confirmed by build-testing this
   * session. */
  soundCard: string;
  tag: string;
  /** Human-readable zone name (Snapcast's Client.SetName -- see
   * renameLocalSnapclientZone below). */
  zoneName: string;
}

export interface LocalSnapclientBuildInputs {
  local: LocalSnapclientConfig;
}

/** Full ContainerConfig for a tag (pure -- unit-tested directly, same
 * shape as signalk-wyoming's buildLocalSatelliteConfig). */
export function buildLocalSnapclientConfig(
  tag: string,
  inputs: LocalSnapclientBuildInputs,
): ContainerConfig {
  const config: ContainerConfig = {
    image: LOCAL_SNAPCLIENT_IMAGE,
    tag,
    env: {
      SNAPCAST_HOST: SK_HOST_ALIAS,
      SNAPCAST_PORT: String(SNAPCAST_STREAM_PORT),
      SOUND_CARD: inputs.local.soundCard,
    },
    extraHosts: { [SK_HOST_ALIAS]: "host-gateway" },
    restart: "unless-stopped",
    resources: { cpus: 0.5, memory: "128m", memorySwap: "128m" },
  };
  // Audio-device passthrough: same signalk-container >= 1.23.2 feature
  // signalk-wyoming's local-satellite.ts depends on for its own mic/
  // speaker container. Not yet in ManagedContainerOptions' public
  // ContainerConfig type (forwarded via an extended cast, matching that
  // file's own workaround) -- silently dropped by older signalk-
  // container versions, no drift loops either way.
  const forward = config as ContainerConfig & {
    devices?: string[];
    groupAdd?: string[];
  };
  forward.devices = ["/dev/snd"];
  forward.groupAdd = ["audio"];
  return config;
}

export interface LocalSnapclientAppLike {
  debug(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
}

export interface LocalSnapclientDeps {
  app: LocalSnapclientAppLike;
  local: LocalSnapclientConfig;
}

export interface LocalSnapclientHandle {
  container: ManagedContainer;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createLocalSnapclient(
  deps: LocalSnapclientDeps,
): LocalSnapclientHandle {
  const container = new ManagedContainer({
    app: deps.app,
    pluginId: "signalk-jukebox",
    name: LOCAL_SNAPCLIENT_CONTAINER_NAME,
    image: LOCAL_SNAPCLIENT_IMAGE,
    defaultTag: "latest",
    resolveTag: (requested) => (requested === "auto" ? "latest" : requested),
    buildConfig: (tag) =>
      buildLocalSnapclientConfig(tag, { local: deps.local }),
    // No readiness gate: unlike signalk-wyoming's local satellite (which
    // has an HTTP control API), a bare snapclient has no HTTP surface to
    // poll -- "started" here means the container is running, not that it
    // has necessarily connected to the jukebox stream yet. Real
    // connection state shows up the normal way, as a zone in
    // GET /api/zones (zone-sync.ts) once Snapserver sees it.
  });

  return {
    container,
    async start(): Promise<void> {
      await container.start(deps.local.tag);
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}

/** Minimal shape this needs from SnapserverClient (avoids a hard import --
 * mirrors zone-sync.ts's own SnapGroup/SnapClient structural typing). */
export interface RenameableSnapserverClient {
  getGroups(): Promise<{ clients: { id: string }[] }[]>;
  setClientName(clientId: string, name: string): Promise<void>;
}

/**
 * Waits for the local snapclient's fixed, known Snapcast client id
 * (LOCAL_SNAPCLIENT_HOST_ID) to show up as a connected zone, then sets its
 * display name once (SPEC.md §9). Client.SetName persists server-side
 * across reconnects, so this only needs to succeed once per plugin start,
 * not on every zone-sync poll tick -- unlike zone-sync.ts, which
 * continuously reconciles state that can change at any time, this is a
 * one-shot action once the precondition (the client exists) is met.
 *
 * Polls independently of zone-sync.ts rather than piggybacking on it:
 * the container can take a few seconds to connect after start(), and this
 * has nothing to do with zone-sync's own responsibility (mirroring
 * Snapserver's canonical state into the store) -- it would be an odd fit
 * bolted onto that loop's per-tick logic.
 */
export function renameLocalSnapclientZone(
  snapserver: RenameableSnapserverClient,
  zoneName: string,
  {
    intervalMs = 2000,
    maxAttempts = 30,
  }: { intervalMs?: number; maxAttempts?: number } = {},
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (attempt: number): Promise<void> => {
    if (stopped) return;
    try {
      const groups = await snapserver.getGroups();
      const found = groups.some((g) =>
        g.clients.some((c) => c.id === LOCAL_SNAPCLIENT_HOST_ID),
      );
      if (found) {
        await snapserver.setClientName(LOCAL_SNAPCLIENT_HOST_ID, zoneName);
        return;
      }
    } catch {
      // Transient/unreachable -- retry on the next tick, same as
      // zone-sync.ts's own tolerance for a not-yet-ready Snapserver.
    }
    if (!stopped && attempt + 1 < maxAttempts) {
      timer = setTimeout(() => void tick(attempt + 1), intervalMs);
    }
  };

  void tick(0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
