// Minimal Snapserver JSON-RPC control client (ARCHITECTURE.md §2.2, §5).
// Snapserver's control API is documented in the Snapcast repo at
// doc/json_rpc_api/control.md (project moved from badaix/snapcast to
// snapcast/snapcast). Confirmed via research (SPEC.md §13): Snapserver
// >= 0.33.0 (pinned by this project's image, ARCHITECTURE.md §2.4) allows
// Stream.AddStream/RemoveStream to create and cleanly remove
// process/airplay-type streams via a `stream.sandbox_dir` executable-path
// check -- the earlier v0.31.0-v0.32.x type whitelist that blocked this
// no longer applies to the version this project requires.
//
// Each zone (Snapclient) keeps its own Snapcast-assigned group -- there is
// no Group.Create/Delete RPC, and this plugin never needs one: switching
// a zone between the Jukebox stream and its own AirPlay receiver is
// `Group.SetStream` on that zone's *existing* group, not a client
// reassignment between groups (SPEC.md §6.4).

export interface SnapClient {
  id: string;
  name: string;
  connected: boolean;
  volume: number;
  muted: boolean;
  groupId: string;
}

export interface SnapGroup {
  id: string;
  streamId: string;
  clients: SnapClient[];
}

export interface SnapserverClientOptions {
  host: string;
  port: number; // control API port, typically 1705
  fetchImpl?: typeof fetch;
}

let nextId = 1;

export class SnapserverClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ host, port, fetchImpl = fetch }: SnapserverClientOptions) {
    this.url = `http://${host}:${port}/jsonrpc`;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: nextId++, jsonrpc: "2.0", method, params }),
    });
    if (!res.ok) {
      throw new Error(`Snapserver RPC ${method} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (body.error) {
      throw new Error(`Snapserver RPC ${method} error: ${body.error.message}`);
    }
    return body.result as T;
  }

  getGroups(): Promise<SnapGroup[]> {
    // TODO(implementation): Server.GetStatus returns the full server tree
    // (groups + streams); this should parse that response into SnapGroup[]
    // rather than assume a dedicated Group.GetStatus-per-group loop.
    return this.call<{ groups: SnapGroup[] }>("Server.GetStatus").then(
      (r) => r.groups,
    );
  }

  setClientVolume(
    clientId: string,
    volume: number,
    muted: boolean,
  ): Promise<void> {
    return this.call("Client.SetVolume", {
      id: clientId,
      volume: { percent: volume, muted },
    });
  }

  /** Point an existing group at a different stream (SPEC.md §6.4) --
   * fully dynamic, no restart. This is how a zone switches between the
   * Jukebox stream and its own AirPlay receiver; it does not move
   * clients between groups or create either one. */
  setGroupStream(groupId: string, streamId: string): Promise<void> {
    return this.call("Group.SetStream", { id: groupId, stream_id: streamId });
  }

  /** Create a stream at runtime (SPEC.md §6.4, §13). Confirmed to work
   * for `airplay://` URIs on Snapserver >= 0.33.0, given the target
   * executable lives inside the server's configured `sandbox_dir`. */
  addStream(streamUri: string): Promise<{ streamId: string }> {
    return this.call<{ stream_id: string }>("Stream.AddStream", {
      streamUri,
    }).then((r) => ({ streamId: r.stream_id }));
  }

  /** Remove a stream at runtime -- confirmed (SPEC.md §13) to SIGINT the
   * underlying process (shairport-sync, for an airplay stream) and its
   * children, and to unassign (not error) any group still pointed at it. */
  removeStream(streamId: string): Promise<void> {
    return this.call("Stream.RemoveStream", { id: streamId });
  }
}
