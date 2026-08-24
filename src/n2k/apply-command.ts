// Dispatches a decoded Fusion-Link command (fusion.ts's own
// FusionIncomingCommand) to the real backend, through the exact same
// methods the REST/webapp write paths already use (controls.ts's
// play/pause/next/previous dispatch, put-handlers.ts's zone-volume write)
// -- SPEC.md §6.3: "every accepted command is applied to canonical state
// via the same path a REST/web write would take -- an MFD is not a
// second-class caller." Kept out of index.ts (which is "mostly wiring",
// per its own doc comment) for the same reason put-handlers.ts is its own
// file: this has real dispatch logic worth testing on its own.

import type { MopidyClient } from "../mopidy-client.js";
import type { SnapserverClient } from "../snapserver-client.js";
import type { StateStore } from "../state/store.js";
import type { FusionIncomingCommand } from "./fusion.js";

export interface ApplyFusionCommandDeps {
  mopidy: MopidyClient | null;
  snapserver: SnapserverClient | null;
  store: StateStore;
  onError: (message: string) => void;
  /** Called for "requestStatus" -- a real MFD sends this wanting an
   * immediate fresh snapshot, so the caller re-broadcasts right away
   * rather than making it wait for the next periodic refresh. */
  onRequestStatus: () => void;
}

export async function applyFusionCommand(
  command: FusionIncomingCommand,
  deps: ApplyFusionCommandDeps,
): Promise<void> {
  const { mopidy, snapserver, store, onError, onRequestStatus } = deps;

  try {
    switch (command.type) {
      case "play":
      case "pause":
      case "next":
      case "previous": {
        if (!mopidy) return; // container not ready yet -- same silent no-op controls.ts's own guard gives a repeated press
        await mopidy[command.type]();
        return;
      }

      case "zoneVolume": {
        if (!snapserver) return;
        const zone = store
          .getZones()
          .find((z) => z.n2kZone === command.n2kZone);
        if (!zone) return; // no zone claimed this n2kZone (yet, or ever)
        const volume = Math.max(0, Math.min(100, Math.round(command.volume)));
        await snapserver.setClientVolume(zone.id, volume, zone.muted);
        store.setZone({ ...zone, volume });
        return;
      }

      case "masterMute": {
        if (!mopidy) return;
        await mopidy.setMute(command.muted);
        store.setPlayback({ ...store.getPlayback(), muted: command.muted });
        return;
      }

      case "requestStatus": {
        onRequestStatus();
        return;
      }
    }
  } catch (err) {
    onError(
      `signalk-jukebox: could not apply Fusion-Link command (${command.type}): ${String(err)}`,
    );
  }
}
