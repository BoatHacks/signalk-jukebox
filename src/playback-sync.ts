import type { StateStore } from "./state/store.js";
import type { MopidyClient, MopidyTrack } from "./mopidy-client.js";
import type { Track } from "./types.js";

// Keeps the canonical store's playback state in sync with Mopidy's actual
// state (ARCHITECTURE.md §2.2) -- polling, same pattern zone-sync.ts uses
// for Snapserver, and for the same reason: no WS event-stream connection
// exists yet (mopidy-client.ts's own top comment). Without this, the
// store's playback.state never left createInitialState()'s "stopped"
// default no matter what was actually playing -- confirmed by a real user
// report: the config panel's status card showed "stopped" while
// SignalK's own native plugin-status line (a one-time "Running on port
// N" set at container start, §9 -- a different question, "is the
// container up", not "is music playing") correctly showed the container
// running.

const DEFAULT_INTERVAL_MS = 2000;

function toTrack(track: MopidyTrack): Track {
  return {
    uri: track.uri,
    name: track.name,
    artist: track.artists.length
      ? track.artists.map((a) => a.name).join(", ")
      : undefined,
    album: track.album?.name,
    durationMs: track.length ?? undefined,
  };
}

export function startPlaybackSync(
  store: StateStore,
  mopidy: MopidyClient,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      const [state, mopidyTrack, volume, muted] = await Promise.all([
        mopidy.getState(),
        mopidy.getCurrentTrack(),
        mopidy.getVolume(),
        mopidy.getMute(),
      ]);
      store.setPlayback({
        state,
        volume: volume ?? 0,
        muted,
        track: mopidyTrack ? toTrack(mopidyTrack) : undefined,
      });
    } catch {
      // Transient/unreachable -- leave existing store state, retry next tick.
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
