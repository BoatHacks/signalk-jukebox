// Backs GET /api/versions (routes.ts) for the config panel's image-version
// dropdown (SPEC.md §6.1, signalk-container-helper/ui's VersionSelect).
//
// None of signalk-container-helper's built-in VersionSourceSpec variants
// fit this project's registry: `githubReleases` lists a git repo's tags/
// releases, `dockerHubTags` is a different registry entirely -- this image
// is published straight to GHCR (ghcr.io/boathacks/signalk-jukebox) via a
// manual `podman push`, with no GitHub Release cut per image tag. So this
// talks to GHCR's own Docker Registry HTTP API v2 directly: an anonymous
// pull-scope token, then GET .../tags/list -- confirmed by hand that a
// public GHCR package needs no credentials for this, the same as an
// anonymous `docker pull`.

import type { VersionInfo } from "signalk-container-helper/ui";
// Type-only import: the /ui subpath pulls in React, which the server-side
// bundle (this file) must never depend on at runtime.

// "latest" is supplied separately as VersionSelect's own default
// floatingOptions -- listing it again here would just be a redundant,
// deduplicated entry.
const FLOATING_TAGS = new Set(["latest"]);
const SEMVER_RE = /^v?\d+\.\d+\.\d+/;

export interface GhcrFetchLike {
  (
    url: string,
    init?: { headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

function repoPath(image: string): string {
  return image.replace(/^ghcr\.io\//, "");
}

export async function fetchGhcrVersions(
  image: string,
  fetchImpl: GhcrFetchLike = fetch,
): Promise<VersionInfo[]> {
  const repo = repoPath(image);

  const tokenRes = await fetchImpl(
    `https://ghcr.io/token?scope=repository:${repo}:pull`,
  );
  if (!tokenRes.ok) {
    throw new Error(`GHCR token request failed: HTTP ${tokenRes.status}`);
  }
  const { token } = (await tokenRes.json()) as { token: string };

  const tagsRes = await fetchImpl(`https://ghcr.io/v2/${repo}/tags/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!tagsRes.ok) {
    throw new Error(`GHCR tags/list failed: HTTP ${tagsRes.status}`);
  }
  const { tags } = (await tagsRes.json()) as { tags: string[] };

  return tags
    .filter((tag) => !FLOATING_TAGS.has(tag))
    .map((tag) => ({ tag, prerelease: !SEMVER_RE.test(tag) }));
}
