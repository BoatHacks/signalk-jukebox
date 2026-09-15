import {
  ManagedContainer,
  type ContainerConfig,
} from "signalk-container-helper";
import { SNAPCAST_STREAM_PORT, SNAPCAST_CONTROL_PORT } from "./container.js";
import { SK_HOST_ALIAS } from "./local-snapclient.js";

// Wyoming bridge (ARCHITECTURE.md §2.4-adjacent, same shape as
// local-snapclient.ts): an optional, MULTI-instance managed container --
// unlike the local snapclient (always exactly one per plugin instance),
// there can be zero or several of these, one per Wyoming voice satellite
// whose speaker should also act as a jukebox zone (e.g. an
// espos-p4-cockpit panel's onboard speaker, which has no Snapcast client
// of its own -- see BoatHacks/signalk-jukebox-wyoming-bridge's own README
// for why this exists and how it works). Reuses SK_HOST_ALIAS from
// local-snapclient.ts -- same host-gateway mechanism, same reason.

export const WYOMING_BRIDGE_IMAGE =
  "ghcr.io/boathacks/signalk-jukebox-wyoming-bridge";

const WYOMING_BRIDGE_NAME_PREFIX = "wyoming-bridge-";

/** Container name for one bridge entry. Distinct from its Snapcast client
 * id (which is `entry.id` verbatim, passed as BRIDGE_ID) -- kept as a
 * separate function so a future container-naming convention change
 * doesn't have to also mean a Snapcast client id change, even though they
 * happen to share the same source value today. */
export function wyomingBridgeContainerName(id: string): string {
  return `${WYOMING_BRIDGE_NAME_PREFIX}${id}`;
}

/**
 * Bridge entry ids this plugin previously created a container for (per
 * state/wyoming-bridge-ids-file.ts) that are no longer wanted -- removed
 * from settings.wyomingBridges entirely, or left in the array but
 * disabled. Pure diff (no side effects), so it's unit-testable without a
 * real container manager; index.ts converts each id to a container name
 * (wyomingBridgeContainerName) and does the actual removal via
 * ContainerManagerApi.remove().
 *
 * Confirmed live this needed fixing, not a theoretical gap: an entry
 * removed from settings and the plugin restarted left its old container
 * running forever, unmanaged -- unlike local-snapclient.ts, which never
 * needs this (it's a single on/off toggle, not a collection, so there is
 * never an "entry that used to exist").
 *
 * Diffs against a persisted id list, NOT ContainerManagerApi.listContainers()
 * -- confirmed live against a real signalk-container that listContainers()
 * does not report a container this plugin created in an EARLIER process
 * lifetime at all (reflects the manager's own in-session bookkeeping, not
 * a live host scan), while a direct manager.remove(name) by a name this
 * plugin already knows works regardless. Tracking the id ourselves is the
 * actual fix, not a workaround for a nicer API.
 */
export function orphanedWyomingBridgeIds(
  previouslyKnownIds: string[],
  enabledEntryIds: string[],
): string[] {
  const enabled = new Set(enabledEntryIds);
  return previouslyKnownIds.filter((id) => !enabled.has(id));
}

export interface WyomingBridgeEntryConfig {
  /** Stable key: this entry's Snapcast client id (BRIDGE_ID) AND its
   * container name suffix. Not the display name -- same id/name split as
   * LOCAL_SNAPCLIENT_HOST_ID vs zoneName in local-snapclient.ts, and for
   * the same reason: renaming the zone later must not orphan the
   * container or lose the client's identity. */
  id: string;
  enabled: boolean;
  /** Human-readable zone name (Snapcast's Client.SetName). */
  zoneName: string;
  satelliteHost: string;
  satellitePort: number;
  tag: string;
}

/** Full ContainerConfig for one bridge entry (pure -- unit-tested
 * directly, same shape as buildLocalSnapclientConfig). No /dev/snd
 * passthrough unlike the local snapclient: this container has no
 * hardware of its own, only outbound TCP to the Snapserver and the
 * target satellite, so it doesn't need audio-device access at all. */
export function buildWyomingBridgeConfig(
  tag: string,
  entry: WyomingBridgeEntryConfig,
): ContainerConfig {
  return {
    image: WYOMING_BRIDGE_IMAGE,
    tag,
    env: {
      SNAPCAST_HOST: SK_HOST_ALIAS,
      SNAPCAST_PORT: String(SNAPCAST_STREAM_PORT),
      SNAPCAST_CONTROL_PORT: String(SNAPCAST_CONTROL_PORT),
      WYOMING_HOST: entry.satelliteHost,
      WYOMING_PORT: String(entry.satellitePort),
      BRIDGE_ID: entry.id,
    },
    extraHosts: { [SK_HOST_ALIAS]: "host-gateway" },
    restart: "unless-stopped",
    // Real measured footprint (podman stats against a live bridge,
    // playing + polling): ~21 MB RSS, ~3.5% CPU -- tighter than
    // local-snapclient's 128m/0.5 cpu (that one also runs an ALSA
    // pipeline; this one is just snapclient's file player + a small
    // Node process).
    resources: { cpus: 0.25, memory: "64m", memorySwap: "64m" },
  };
}

export interface WyomingBridgeAppLike {
  debug(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
}

export interface WyomingBridgeDeps {
  app: WyomingBridgeAppLike;
  entry: WyomingBridgeEntryConfig;
}

export interface WyomingBridgeHandle {
  container: ManagedContainer;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** One bridge's ManagedContainer. Callers manage a collection of these,
 * one per enabled entry in settings.wyomingBridges -- see index.ts. */
export function createWyomingBridge(
  deps: WyomingBridgeDeps,
): WyomingBridgeHandle {
  const container = new ManagedContainer({
    app: deps.app,
    pluginId: "signalk-jukebox",
    name: wyomingBridgeContainerName(deps.entry.id),
    image: WYOMING_BRIDGE_IMAGE,
    defaultTag: "latest",
    resolveTag: (requested) => (requested === "auto" ? "latest" : requested),
    buildConfig: (tag) => buildWyomingBridgeConfig(tag, deps.entry),
    // No readiness gate, same reasoning as local-snapclient.ts: no HTTP
    // surface to poll. Connection state shows up as a zone in
    // GET /api/zones once Snapserver sees it.
  });

  return {
    container,
    async start(): Promise<void> {
      await container.start(deps.entry.tag);
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}

/** Minimal shape this needs from SnapserverClient -- same structural
 * typing local-snapclient.ts's RenameableSnapserverClient uses. */
export interface RenameableSnapserverClient {
  getGroups(): Promise<{ clients: { id: string }[] }[]>;
  setClientName(clientId: string, name: string): Promise<void>;
}

/**
 * Waits for a bridge's fixed Snapcast client id to show up as a
 * connected zone, then sets its display name once. Same polling shape
 * and reasoning as local-snapclient.ts's renameLocalSnapclientZone
 * (unbounded retry by default -- a short one was confirmed by hand to be
 * a real bug there, not a theoretical edge case, after a full-reboot cold
 * start took longer than a 60s budget), generalized to take the client
 * id as a parameter instead of a single fixed constant, since there can
 * be several bridges each needing their own independent poller.
 */
export function renameWyomingBridgeZone(
  snapserver: RenameableSnapserverClient,
  clientId: string,
  zoneName: string,
  {
    intervalMs = 2000,
    maxAttempts = Infinity,
  }: { intervalMs?: number; maxAttempts?: number } = {},
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (attempt: number): Promise<void> => {
    if (stopped) return;
    try {
      const groups = await snapserver.getGroups();
      const found = groups.some((g) =>
        g.clients.some((c) => c.id === clientId),
      );
      if (found) {
        await snapserver.setClientName(clientId, zoneName);
        return;
      }
    } catch {
      // Transient/unreachable -- retry on the next tick, same tolerance
      // as renameLocalSnapclientZone.
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
