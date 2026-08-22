import { describe, it, expect } from "vitest";
import { claimN2kZone, nextFreeN2kZone } from "../src/n2k/zone-mapping.js";
import type { ZoneAssignment } from "../src/types.js";

describe("nextFreeN2kZone", () => {
  it("returns 0 when nothing is assigned", () => {
    expect(nextFreeN2kZone({}, 4)).toBe(0);
  });

  it("skips taken zones", () => {
    const assignments: Record<string, ZoneAssignment> = {
      cockpit: { n2kZone: 0 },
      salon: { n2kZone: 1 },
    };
    expect(nextFreeN2kZone(assignments, 4)).toBe(2);
  });

  it("returns undefined when the range is full", () => {
    const assignments: Record<string, ZoneAssignment> = {
      a: { n2kZone: 0 },
      b: { n2kZone: 1 },
    };
    expect(nextFreeN2kZone(assignments, 2)).toBeUndefined();
  });
});

describe("claimN2kZone", () => {
  it("assigns the next free zone number and persists it", () => {
    const assignments: Record<string, ZoneAssignment> = {};
    const zone = claimN2kZone(assignments, "cockpit", 4);
    expect(zone).toBe(0);
    expect(assignments.cockpit).toEqual({ n2kZone: 0 });
  });

  it("is idempotent -- a zone that already has one keeps it", () => {
    const assignments: Record<string, ZoneAssignment> = {
      cockpit: { n2kZone: 2 },
    };
    const zone = claimN2kZone(assignments, "cockpit", 4);
    expect(zone).toBe(2);
    expect(assignments.cockpit).toEqual({ n2kZone: 2 });
  });

  it("never reassigns a different zone's already-taken number", () => {
    const assignments: Record<string, ZoneAssignment> = {
      cockpit: { n2kZone: 0 },
    };
    claimN2kZone(assignments, "salon", 4);
    expect(assignments.cockpit).toEqual({ n2kZone: 0 });
    expect(assignments.salon).toEqual({ n2kZone: 1 });
  });

  it("returns undefined and leaves assignments unchanged when full", () => {
    const assignments: Record<string, ZoneAssignment> = {
      a: { n2kZone: 0 },
      b: { n2kZone: 1 },
    };
    const zone = claimN2kZone(assignments, "c", 2);
    expect(zone).toBeUndefined();
    expect(assignments.c).toBeUndefined();
  });
});
