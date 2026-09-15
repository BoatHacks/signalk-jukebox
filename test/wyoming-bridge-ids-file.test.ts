import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadKnownWyomingBridgeIds,
  saveKnownWyomingBridgeIds,
} from "../src/state/wyoming-bridge-ids-file.js";

describe("wyoming-bridge-ids-file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(
      path.join(tmpdir(), "signalk-jukebox-wyoming-bridge-ids-"),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty array when nothing has ever been persisted (fresh install)", async () => {
    const ids = await loadKnownWyomingBridgeIds(dir);
    expect(ids).toEqual([]);
  });

  it("round-trips a real save through a real load", async () => {
    await saveKnownWyomingBridgeIds(dir, ["salon-panel", "v-berth-panel"]);
    const loaded = await loadKnownWyomingBridgeIds(dir);
    expect(loaded).toEqual(["salon-panel", "v-berth-panel"]);
  });

  it("creates the data directory if it doesn't exist yet", async () => {
    const nested = path.join(dir, "does", "not", "exist", "yet");
    await saveKnownWyomingBridgeIds(nested, ["salon-panel"]);
    const loaded = await loadKnownWyomingBridgeIds(nested);
    expect(loaded).toEqual(["salon-panel"]);
  });

  it("writes atomically -- no .tmp file left behind after a successful save", async () => {
    await saveKnownWyomingBridgeIds(dir, ["salon-panel"]);
    await expect(
      readFile(path.join(dir, "wyoming-bridge-ids.json.tmp"), "utf8"),
    ).rejects.toThrow();
  });

  it("falls back to an empty array for corrupt JSON, rather than throwing", async () => {
    await writeFile(
      path.join(dir, "wyoming-bridge-ids.json"),
      "{not valid json",
      "utf8",
    );
    const ids = await loadKnownWyomingBridgeIds(dir);
    expect(ids).toEqual([]);
  });

  it("falls back to an empty array for a validly-parsed but non-string-array JSON value", async () => {
    await writeFile(
      path.join(dir, "wyoming-bridge-ids.json"),
      JSON.stringify({ not: "an array" }),
      "utf8",
    );
    const ids = await loadKnownWyomingBridgeIds(dir);
    expect(ids).toEqual([]);
  });

  it("falls back to an empty array for an array with non-string entries", async () => {
    await writeFile(
      path.join(dir, "wyoming-bridge-ids.json"),
      JSON.stringify(["salon-panel", 42]),
      "utf8",
    );
    const ids = await loadKnownWyomingBridgeIds(dir);
    expect(ids).toEqual([]);
  });

  it("a later save overwrites an earlier one entirely, not merges", async () => {
    await saveKnownWyomingBridgeIds(dir, ["salon-panel"]);
    await saveKnownWyomingBridgeIds(dir, ["v-berth-panel"]);
    const loaded = await loadKnownWyomingBridgeIds(dir);
    expect(loaded).toEqual(["v-berth-panel"]);
  });
});
