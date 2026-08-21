import { describe, it, expect } from "vitest";
import { claimSlot, nextFreeSlot } from "../src/n2k/zone-mapping.js";
import type { ZoneAssignment } from "../src/types.js";

describe("nextFreeSlot", () => {
  it("returns 0 when nothing is assigned", () => {
    expect(nextFreeSlot({}, 4, "n2kZone")).toBe(0);
  });

  it("skips taken slots", () => {
    const assignments: Record<string, ZoneAssignment> = {
      cockpit: { n2kZone: 0 },
      salon: { n2kZone: 1 },
    };
    expect(nextFreeSlot(assignments, 4, "n2kZone")).toBe(2);
  });

  it("returns undefined when the pool is full", () => {
    const assignments: Record<string, ZoneAssignment> = {
      a: { n2kZone: 0 },
      b: { n2kZone: 1 },
    };
    expect(nextFreeSlot(assignments, 2, "n2kZone")).toBeUndefined();
  });

  it("tracks n2kZone and airplaySlot independently", () => {
    const assignments: Record<string, ZoneAssignment> = {
      cockpit: { n2kZone: 0, airplaySlot: 3 },
    };
    expect(nextFreeSlot(assignments, 4, "n2kZone")).toBe(1);
    expect(nextFreeSlot(assignments, 4, "airplaySlot")).toBe(0);
  });
});

describe("claimSlot", () => {
  it("assigns the next free slot and persists it", () => {
    const assignments: Record<string, ZoneAssignment> = {};
    const slot = claimSlot(assignments, "cockpit", 4, "n2kZone");
    expect(slot).toBe(0);
    expect(assignments.cockpit).toEqual({ n2kZone: 0 });
  });

  it("is idempotent -- a zone that already has a slot keeps it", () => {
    const assignments: Record<string, ZoneAssignment> = {
      cockpit: { n2kZone: 2 },
    };
    const slot = claimSlot(assignments, "cockpit", 4, "n2kZone");
    expect(slot).toBe(2);
    expect(assignments.cockpit).toEqual({ n2kZone: 2 });
  });

  it("never reassigns a different zone's already-taken slot", () => {
    const assignments: Record<string, ZoneAssignment> = {
      cockpit: { n2kZone: 0 },
    };
    claimSlot(assignments, "salon", 4, "n2kZone");
    expect(assignments.cockpit).toEqual({ n2kZone: 0 });
    expect(assignments.salon).toEqual({ n2kZone: 1 });
  });

  it("returns undefined and leaves assignments unchanged when full", () => {
    const assignments: Record<string, ZoneAssignment> = {
      a: { n2kZone: 0 },
      b: { n2kZone: 1 },
    };
    const slot = claimSlot(assignments, "c", 2, "n2kZone");
    expect(slot).toBeUndefined();
    expect(assignments.c).toBeUndefined();
  });

  it("claiming n2kZone doesn't consume an airplaySlot for the same zone", () => {
    const assignments: Record<string, ZoneAssignment> = {};
    claimSlot(assignments, "cockpit", 4, "n2kZone");
    const airplaySlot = claimSlot(assignments, "cockpit", 4, "airplaySlot");
    expect(airplaySlot).toBe(0);
    expect(assignments.cockpit).toEqual({ n2kZone: 0, airplaySlot: 0 });
  });
});
