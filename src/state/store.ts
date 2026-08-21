import { EventEmitter } from "node:events";
import type {
  CanonicalState,
  PlaybackState,
  Zone,
  ZoneAssignment,
} from "../types.js";

// The single writable copy of playback/zone state (ARCHITECTURE.md §2.1).
// Every adapter (Mopidy/Snapserver, N2K/Fusion, REST, SK paths) reads this
// store and writes to it -- never to each other directly.
//
// Write discipline (SPEC.md §3.2): an adapter applies an incoming command
// to the real backend (Mopidy or Snapserver) first; the backend's actual
// resulting state -- confirmed via its own event stream, not assumed
// optimistically -- is what gets written here. That is what makes
// last-write-wins (SPEC.md §12) safe: the store never ends up holding a
// value neither backend actually has.

export type StateChangeEvent =
  | { type: "playback"; playback: PlaybackState }
  | { type: "zone"; zoneId: string; zone: Zone }
  | { type: "zoneRemoved"; zoneId: string };

type ChangeListener = (change: StateChangeEvent) => void;

// A plain (untyped) EventEmitter is used internally rather than typing
// on()/emit() via declaration merging -- that pattern trips
// no-unsafe-declaration-merging, and buys nothing a small typed
// onChange/offChange wrapper doesn't already give every caller.
export class StateStore {
  private readonly emitter = new EventEmitter();
  private state: CanonicalState;

  constructor(initial: CanonicalState) {
    this.state = initial;
  }

  onChange(listener: ChangeListener): void {
    this.emitter.on("change", listener);
  }

  offChange(listener: ChangeListener): void {
    this.emitter.off("change", listener);
  }

  private emitChange(change: StateChangeEvent): void {
    this.emitter.emit("change", change);
  }

  getPlayback(): PlaybackState {
    return this.state.playback;
  }

  setPlayback(playback: PlaybackState): void {
    this.state.playback = playback;
    this.emitChange({ type: "playback", playback });
  }

  getZone(id: string): Zone | undefined {
    return this.state.zones[id];
  }

  getZones(): Zone[] {
    return Object.values(this.state.zones);
  }

  setZone(zone: Zone): void {
    this.state.zones[zone.id] = zone;
    this.emitChange({ type: "zone", zoneId: zone.id, zone });
  }

  removeZone(id: string): void {
    if (!(id in this.state.zones)) return;
    delete this.state.zones[id];
    this.emitChange({ type: "zoneRemoved", zoneId: id });
  }

  getZoneAssignment(id: string): ZoneAssignment | undefined {
    return this.state.zoneAssignments[id];
  }

  /**
   * Assign a zone's n2kZone/airplaySlot once. Never overwrites an existing
   * assignment for a given key (SPEC.md §2, §12) -- callers claiming a slot
   * must check getZoneAssignment() first and only call this for a value
   * that isn't set yet.
   */
  setZoneAssignment(id: string, assignment: ZoneAssignment): void {
    this.state.zoneAssignments[id] = {
      ...this.state.zoneAssignments[id],
      ...assignment,
    };
  }

  getN2kDeviceState() {
    return this.state.n2kDeviceState;
  }

  setN2kDeviceState(value: CanonicalState["n2kDeviceState"]): void {
    this.state.n2kDeviceState = value;
  }

  /** Snapshot for persistence (SPEC.md §8) -- zoneAssignments only; the
   * rest of the store is rebuilt from Mopidy/Snapserver on each start. */
  getPersistedZoneAssignments(): Record<string, ZoneAssignment> {
    return { ...this.state.zoneAssignments };
  }

  restoreZoneAssignments(assignments: Record<string, ZoneAssignment>): void {
    this.state.zoneAssignments = { ...assignments };
  }
}

export function createInitialState(): CanonicalState {
  return {
    playback: { state: "stopped", volume: 0, muted: false },
    zones: {},
    zoneAssignments: {},
    n2kDeviceState: "unclaimed",
  };
}
