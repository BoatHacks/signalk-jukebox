// Minimal Mopidy JSON-RPC client (ARCHITECTURE.md §2.2, §5). Mopidy exposes
// its core API over JSON-RPC 2.0 at POST /mopidy/rpc; TODO(implementation):
// the event-stream subscription (core.playback state changes, volume
// changes) uses Mopidy's separate WebSocket endpoint
// (ws://<host>/mopidy/ws), not implemented here yet -- playback-sync.ts
// instead polls this request/response API on a timer (same pattern
// zone-sync.ts uses for Snapserver), not real push events.

/** Mopidy's own Track model shape (core.playback.get_current_track),
 * confirmed against a real running Mopidy 4.x instance -- `artists` is
 * always an array (possibly empty, e.g. an internet radio stream with no
 * tagged artist), `album` is the object or `null`, not omitted. */
export interface MopidyTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string } | null;
  length: number | null;
}

export interface MopidyClientOptions {
  baseUrl: string; // e.g. http://127.0.0.1:6680
  fetchImpl?: typeof fetch;
}

let nextId = 1;

export class MopidyClient {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ baseUrl, fetchImpl = fetch }: MopidyClientOptions) {
    this.rpcUrl = `${baseUrl.replace(/\/$/, "")}/mopidy/rpc`;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params,
      }),
    });
    if (!res.ok) {
      throw new Error(`Mopidy RPC ${method} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (body.error) {
      throw new Error(`Mopidy RPC ${method} error: ${body.error.message}`);
    }
    return body.result as T;
  }

  getState(): Promise<"playing" | "paused" | "stopped"> {
    return this.call("core.playback.get_state");
  }

  getVolume(): Promise<number | null> {
    return this.call("core.mixer.get_volume");
  }

  setVolume(volume: number): Promise<boolean> {
    return this.call("core.mixer.set_volume", { volume });
  }

  getMute(): Promise<boolean> {
    return this.call("core.mixer.get_mute");
  }

  setMute(muted: boolean): Promise<boolean> {
    return this.call("core.mixer.set_mute", { mute: muted });
  }

  getCurrentTrack(): Promise<MopidyTrack | null> {
    return this.call("core.playback.get_current_track");
  }

  play(): Promise<void> {
    return this.call("core.playback.play");
  }

  pause(): Promise<void> {
    return this.call("core.playback.pause");
  }

  next(): Promise<void> {
    return this.call("core.playback.next");
  }

  previous(): Promise<void> {
    return this.call("core.playback.previous");
  }

  // TODO(SPEC.md §8): tracklist snapshot/restore for queue persistence --
  // core.tracklist.get_tl_tracks / core.tracklist.add / core.playback.seek
  // to restore position. Deferred until the WS event-stream connection
  // above exists, since restoring on start needs to know when Mopidy is
  // actually ready to accept tracklist commands.
}
