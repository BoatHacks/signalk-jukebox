import { describe, it, expect, vi } from "vitest";
import { fetchGhcrVersions, type GhcrFetchLike } from "../src/ghcr-versions.js";

function fakeFetch(
  tags: string[],
  opts: { tokenOk?: boolean; tagsOk?: boolean } = {},
): GhcrFetchLike {
  const { tokenOk = true, tagsOk = true } = opts;
  return vi.fn((url: string) => {
    if (url.includes("/token")) {
      return Promise.resolve({
        ok: tokenOk,
        status: tokenOk ? 200 : 401,
        json: () => Promise.resolve({ token: "fake-token" }),
      });
    }
    return Promise.resolve({
      ok: tagsOk,
      status: tagsOk ? 200 : 502,
      json: () => Promise.resolve({ tags }),
    });
  }) as unknown as GhcrFetchLike;
}

describe("fetchGhcrVersions", () => {
  it("fetches a token then the tags list, using the bearer token", async () => {
    const fetchImpl = fakeFetch(["latest", "0.0.1"]);
    await fetchGhcrVersions("ghcr.io/boathacks/signalk-jukebox", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ghcr.io/token?scope=repository:boathacks/signalk-jukebox:pull",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ghcr.io/v2/boathacks/signalk-jukebox/tags/list",
      { headers: { Authorization: "Bearer fake-token" } },
    );
  });

  it("filters out the floating 'latest' tag", async () => {
    const versions = await fetchGhcrVersions(
      "ghcr.io/boathacks/signalk-jukebox",
      fakeFetch(["latest", "0.0.1", "0.0.2"]),
    );
    expect(versions.map((v) => v.tag)).toEqual(["0.0.1", "0.0.2"]);
  });

  it("marks semver-looking tags as stable and others as prerelease", async () => {
    const versions = await fetchGhcrVersions(
      "ghcr.io/boathacks/signalk-jukebox",
      fakeFetch(["0.0.1", "main"]),
    );
    expect(versions).toEqual([
      { tag: "0.0.1", prerelease: false },
      { tag: "main", prerelease: true },
    ]);
  });

  it("throws when the token request fails", async () => {
    await expect(
      fetchGhcrVersions(
        "ghcr.io/boathacks/signalk-jukebox",
        fakeFetch([], { tokenOk: false }),
      ),
    ).rejects.toThrow("GHCR token request failed");
  });

  it("throws when the tags/list request fails", async () => {
    await expect(
      fetchGhcrVersions(
        "ghcr.io/boathacks/signalk-jukebox",
        fakeFetch([], { tagsOk: false }),
      ),
    ).rejects.toThrow("GHCR tags/list failed");
  });
});
