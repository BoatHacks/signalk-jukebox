import { describe, it, expect } from "vitest";
import { openApiDocument } from "../src/openapi.js";

// Not a full OpenAPI validator -- just enough to catch the two mistakes
// most likely in a hand-written doc like this: a $ref pointing at a
// component that doesn't exist, and a path missing from the real route
// list (routes.ts + signalk-container-helper's registerUpdateRoutes).

function collectRefs(node: unknown, refs: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else collectRefs(value, refs);
    }
  }
}

function resolveRef(doc: unknown, ref: string): unknown {
  const path = ref.replace(/^#\//, "").split("/");
  let current: unknown = doc;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe("openApiDocument", () => {
  it("resolves every $ref to a real component", () => {
    const refs: string[] = [];
    collectRefs(openApiDocument, refs);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(resolveRef(openApiDocument, ref)).toBeDefined();
    }
  });

  it("documents every real route this plugin registers", () => {
    // routes.ts's own REST routes, plus registerUpdateRoutes's two
    // (SPEC.md §6.1) -- kept in sync by hand since the doc is hand-
    // written, not generated from routes.ts.
    const expectedPaths = [
      "/api/status",
      "/api/zones",
      "/api/zones/{id}/volume",
      "/api/zones/{id}/mute",
      "/api/zones/{id}/source",
      "/api/zones/{id}/delete",
      "/api/satellites",
      "/api/versions",
      "/api/update/check",
      "/api/update/apply",
    ];
    expect(Object.keys(openApiDocument.paths).sort()).toEqual(
      expectedPaths.sort(),
    );
  });

  it("has a servers entry matching the plugin's real router mount", () => {
    expect(openApiDocument.servers).toEqual([
      { url: "/plugins/signalk-jukebox" },
    ]);
  });
});
