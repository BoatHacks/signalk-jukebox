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
// This is a raw TCP socket client, not HTTP -- confirmed by build-testing
// against a real Snapserver 0.35.0: its control port (the one this
// project's snapserver.conf.template exposes as [http] on 1705) does not
// parse real HTTP requests at all, despite the config section's name.
// Sending an actual `POST /jsonrpc HTTP/1.1` request makes it try to
// JSON-parse the literal request bytes and fail; a bare
// newline-terminated JSON-RPC line is what it actually expects, the same
// wire format the (also raw-socket) tcp-control protocol uses.
//
// Each zone (Snapclient) keeps its own Snapcast-assigned group -- there is
// no Group.Create/Delete RPC, and this plugin never needs one: switching
// a zone between the Jukebox stream and its own AirPlay receiver is
// `Group.SetStream` on that zone's *existing* group, not a client
// reassignment between groups (SPEC.md §6.4).

import { connect, type Socket } from "node:net";

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
  connectImpl?: (port: number, host: string) => Socket;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

interface RawClient {
  id: string;
  connected: boolean;
  config: { name: string; volume: { percent: number; muted: boolean } };
  host: { name: string };
}

interface RawGroup {
  id: string;
  stream_id: string;
  clients: RawClient[];
}

function toSnapGroup(group: RawGroup): SnapGroup {
  return {
    id: group.id,
    streamId: group.stream_id,
    clients: group.clients.map((c) => ({
      id: c.id,
      // config.name is a user-assignable label (Client.SetName), usually
      // empty until set; host.name (the client's own hostname) is the
      // fallback Snapcast's own UIs use for the same reason.
      name: c.config.name || c.host.name,
      connected: c.connected,
      volume: c.config.volume.percent,
      muted: c.config.volume.muted,
      groupId: group.id,
    })),
  };
}

let nextId = 1;

export class SnapserverClient {
  private readonly host: string;
  private readonly port: number;
  private readonly connectImpl: (port: number, host: string) => Socket;
  private socket: Socket | undefined;
  private connecting: Promise<Socket> | undefined;
  private buffer = "";
  private readonly pending = new Map<number, PendingCall>();

  constructor({ host, port, connectImpl = connect }: SnapserverClientOptions) {
    this.host = host;
    this.port = port;
    this.connectImpl = connectImpl;
  }

  private getSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = this.connectImpl(this.port, this.host);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        this.connecting = undefined;
        resolve(socket);
      });
      socket.once("error", (err: Error) => {
        this.connecting = undefined;
        this.socket = undefined;
        reject(err);
      });
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("close", () => this.onClose());
    });

    return this.connecting;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return; // malformed line -- nothing to correlate it to
    }
    if (msg.id === undefined) return; // unsolicited notification (e.g. Stream.OnUpdate)
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onClose(): void {
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Snapserver connection closed"));
    }
    this.pending.clear();
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    const socket = await this.getSocket();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      const line = `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;
      socket.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  getGroups(): Promise<SnapGroup[]> {
    // Server.GetStatus nests groups under result.server.groups, not
    // result.groups -- confirmed by build-testing against a real
    // Snapserver 0.35.0 (the outer "server" key wraps both this server's
    // own identity info, also confusingly under a nested "server" key,
    // and the groups/streams arrays). Raw group/client field names don't
    // match this client's SnapGroup/SnapClient shape either (snake_case
    // stream_id, nested config.volume.{percent,muted}, no flat groupId on
    // a client at all -- it's only implied by nesting) -- also confirmed
    // against a real connected snapclient, not guessed.
    return this.call<{ server: { groups: RawGroup[] } }>(
      "Server.GetStatus",
    ).then((r) => r.server.groups.map(toSnapGroup));
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
