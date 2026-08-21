// Minimal Snapserver JSON-RPC control client (ARCHITECTURE.md §2.2, §5).
// Snapserver's control API is documented in the Snapcast repo at
// doc/json_rpc_api/control.md (project moved from badaix/snapcast to
// snapcast/snapcast). Confirmed via research (SPEC.md §13, current stable
// v0.35.0): only Group.SetClients/Group.SetStream/Client.SetVolume are
// safe to call for the AirPlay pool's dynamic bind/unbind (SPEC.md §6.4);
// Stream.AddStream/RemoveStream exist but are restricted to
// pipe/file/tcp/alsa/jack/meta -- never call them expecting to create an
// airplay stream, that path is deliberately closed (CVE-2023-36177 fix).

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

  /** Bind a client to an already-existing group/stream (SPEC.md §6.4) --
   * fully dynamic, no restart. Does NOT create streams or groups. */
  setClientStream(clientId: string, groupId: string): Promise<void> {
    return this.call("Group.SetClients", { id: groupId, clients: [clientId] });
  }
}
