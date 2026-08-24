import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadZoneAssignments,
  saveZoneAssignments,
} from "../src/state/zone-assignments-file.js";

describe("zone-assignments-file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "signalk-jukebox-zone-assignments-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty object when nothing has ever been persisted (fresh install)", async () => {
    const assignments = await loadZoneAssignments(dir);
    expect(assignments).toEqual({});
  });

  it("round-trips a real save through a real load", async () => {
    await saveZoneAssignments(dir, {
      "zone-a": { n2kZone: 0 },
      "zone-b": { n2kZone: 1 },
    });

    const loaded = await loadZoneAssignments(dir);
    expect(loaded).toEqual({
      "zone-a": { n2kZone: 0 },
      "zone-b": { n2kZone: 1 },
    });
  });

  it("creates the data directory if it doesn't exist yet", async () => {
    const nested = path.join(dir, "does", "not", "exist", "yet");
    await saveZoneAssignments(nested, { "zone-a": { n2kZone: 0 } });

    const loaded = await loadZoneAssignments(nested);
    expect(loaded).toEqual({ "zone-a": { n2kZone: 0 } });
  });

  it("writes atomically -- no .tmp file left behind after a successful save", async () => {
    await saveZoneAssignments(dir, { "zone-a": { n2kZone: 0 } });
    await expect(
      readFile(path.join(dir, "zone-assignments.json.tmp"), "utf8"),
    ).rejects.toThrow();
  });

  it("falls back to an empty object for corrupt JSON, rather than throwing", async () => {
    await writeFile(path.join(dir, "zone-assignments.json"), "{not valid json", "utf8");
    const assignments = await loadZoneAssignments(dir);
    expect(assignments).toEqual({});
  });

  it("falls back to an empty object for a validly-parsed but non-object JSON value", async () => {
    await writeFile(path.join(dir, "zone-assignments.json"), "[1,2,3]", "utf8");
    const assignments = await loadZoneAssignments(dir);
    expect(assignments).toEqual({});
  });

  it("a later save overwrites an earlier one entirely, not merges", async () => {
    await saveZoneAssignments(dir, { "zone-a": { n2kZone: 0 } });
    await saveZoneAssignments(dir, { "zone-b": { n2kZone: 1 } });

    const loaded = await loadZoneAssignments(dir);
    expect(loaded).toEqual({ "zone-b": { n2kZone: 1 } });
  });
});
