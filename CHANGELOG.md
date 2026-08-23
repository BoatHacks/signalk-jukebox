# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A second Snapcast stream, "Alerts" — a standing announcement intake
  (Snapcast's `tcp server` source type, port 4953) any other container or
  process can connect to and stream a WAV-framed announcement into. The
  webapp's per-zone "Play here" toggle now switches a zone to this
  stream when turned off, instead of muting the whole Snapclient — a
  zone taken off the jukebox stream still hears announcements meant for
  it. `POST /api/zones/:id/source` now accepts `"alerts"` alongside the
  existing `"jukebox"`. Reached directly at its own LAN-published port,
  not through this plugin's REST API, so any producer just needs a plain
  TCP connection.
- Snapweb (the official Snapcast web client) — Snapserver's own
  rename/group clients, per-client volume, and stream-switching UI,
  which neither this plugin's own webapp nor Mopidy-MusicBox-Webclient
  has. Installed as a prebuilt `.deb` (image/Dockerfile) and served by
  Snapserver's own `[http]` section (`doc_root`). Confirmed by
  build-testing that it can't share a port with Snapserver's control
  API — an earlier draft that tried broke HTTP parsing for the shared
  port entirely — so it's on its own dedicated port (`SNAPWEB_PORT`,
  1780), with the control API moved to `[tcp-control]` at 1705 instead
  (same wire protocol, no code change needed in
  `src/snapserver-client.ts`). Reached directly on the LAN, same as
  Mopidy-MusicBox-Webclient below, with a link in the config panel.

### Changed

- Replaced the minimal built-in web UI (`image/webui`) with
  Mopidy-MusicBox-Webclient, giving library browse/search/queue/playlist
  management the hand-rolled substitute never had — the closer stand-in
  for Iris while it remains incompatible with Mopidy 4.x
  (jaedb/Iris#999). Confirmed by build-testing that, unlike Iris/TuneIn,
  it doesn't touch the Mopidy-3-era internals Mopidy 4 removed;
  `image/Dockerfile` pins `setuptools<80` for a separate, unrelated
  `pkg_resources` import it still relies on. Its UI is entirely
  WebSocket-driven, which this plugin's reverse proxy can't forward, so
  it's published directly to the LAN (`container.ts`) instead of being
  reverse-proxied — the config panel's "Open" link now points there
  directly. The plugin's own `public/` webapp (playback/zone control, no
  library features) is unaffected, still reverse-proxied as before.

## [0.0.14] - 2026-08-23

### Fixed

- `entertainment.jukebox.playback.volume` and
  `entertainment.jukebox.zones.<id>.volume` were published as 0-100
  with `units: "%"` — SignalK's own convention for a level like this is
  a 0-1 ratio, not a percentage. Converted at this boundary only:
  internally (REST API, Mopidy/Snapcast's own native APIs, the web UI)
  the plugin still uses 0-100 throughout, since that's what those APIs
  actually speak — only `paths.ts`'s published values/meta and the
  matching PUT handlers (which must accept the same shape they publish)
  now convert to/from the SK-facing 0-1 ratio.

## [0.0.13] - 2026-08-23

### Added

- Real metadata (`description`, `units` where numeric, an `example`
  value) for every `entertainment.jukebox.*` path the plugin publishes
  — `playback.state`, `playback.volume`, `playback.track`, and each
  zone's `connected`/`volume`/`muted`/`n2kZone`. SignalK's own meta type
  has no formal "type" field; `description` + `example` is the
  spec-compliant way to convey a value's shape (e.g. that
  `playback.state` is a string).

## [0.0.12] - 2026-08-23

### Added

- Real OpenAPI 3.0.3 documentation (`src/openapi.ts`) for every REST
  endpoint the plugin presents, exposed via the standard
  `plugin.getOpenApi` hook so it shows up in the server's own OpenAPI
  explorer alongside every other plugin's API.

## [0.0.11] - 2026-08-23

### Fixed

- The four `entertainment.jukebox.playback.controls.*` paths were
  impossible to find in the Data Browser or any path picker — a real
  user report. Root cause: the plugin only ever _subscribes_ to them
  (`controls.ts`), never publishes a value or meta, and a path with
  neither is entirely invisible in SignalK's data model until some
  external source sends the first real delta. `registerControlsMeta`
  now publishes a one-time meta-only delta (description, no value) for
  all four on plugin start, so they're discoverable immediately even
  before anything is wired up to press them.

## [0.0.10] - 2026-08-23

### Fixed

- Snapcast completely unreachable (no zones, local snapclient stuck in a
  connection-refused reconnect loop) on any install with
  `airplay.hostNetworking` enabled. Root cause, confirmed against a real
  production instance: `signalkAccessiblePorts` and `networkMode: "host"`
  cannot be combined — signalk-container discards `networkMode` entirely
  the moment `signalkAccessiblePorts` is also set (its own log warning
  names the conflict), silently reverting to bridge mode. Since
  `container.ts` also omits `ports` whenever host networking is
  requested (correctly assuming it would actually apply), the container
  ended up in bridge mode with neither publishing mechanism active at
  all. Fixed by omitting `signalkAccessiblePorts` (and `readiness`,
  which depends on it for address resolution) under host networking,
  substituting a hardcoded `HOST_NETWORKING_ADDRESS` instead — sharing
  the host's network namespace means Mopidy's port simply _is_ the
  host's own port, nothing left to resolve.

## [0.0.9] - 2026-08-23

### Fixed

- Config panel's status card permanently showed "stopped" regardless of
  actual playback, since nothing ever wrote real state into the
  canonical store — `mopidy-client.ts` had the RPC calls but no poll
  loop was ever wired up (a standing TODO). Confirmed via a real user
  report: the status card said "stopped" while SignalK's own native
  plugin-status line correctly showed the container running — two
  different questions ("is music playing" vs. "is the container up")
  that looked like a contradiction. New `playback-sync.ts` (same polling
  pattern `zone-sync.ts` already used for Snapserver) keeps
  state/track/volume/mute in sync with Mopidy's real state every 2s.
  Also new: `MopidyClient.getCurrentTrack()`/`getMute()`.

## [0.0.8] - 2026-08-23

### Changed

- `/signalk-jukebox` (the webapps/App Dock entry) now serves the web
  player directly instead of redirecting into the reverse-proxied
  `/plugins/signalk-jukebox/jukebox/` copy. It's a static duplicate of
  the same UI (`public/index.html`/`app.js`, shipped in the npm package
  itself) with one difference: an absolute API base
  (`/plugins/signalk-jukebox`) instead of the container-served copy's
  relative one, since this page's own URL has nothing to do with where
  the plugin's router is mounted. Side benefit: the page itself now
  loads even before the container is ready — a redirect into the old
  proxied-only copy 503'd the whole page, not just its data, whenever
  the container wasn't up yet.

## [0.0.7] - 2026-08-23

### Fixed

- The local snapclient's zone-renaming (0.0.6) had no effective retry
  budget for a real cold-boot scenario: it gave up after 60s (30 attempts
  x 2s), but confirmed by hand that after a full server reboot, every
  container starts at once and the local snapclient can easily take
  longer than that to actually connect -- the rename silently never
  fired. Now retries for the plugin's whole lifetime instead of a fixed
  attempt count, bounded only by plugin stop/restart, matching
  signalk-container-helper's own "boot race" guidance for the boat case.

### Changed

- npm description no longer lists NMEA2000/Fusion-Link as a working
  integration -- it's designed (SPEC.md §6.3) but not yet implemented
  (`src/n2k/fusion.ts` and `entertainment-pgn.ts` are still stubs).

## [0.0.6] - 2026-08-23

### Added

- `localSnapclient.zoneName` (default `"Local speakers"`), editable in
  the config panel's Local Snapclient section.

### Fixed

- The local snapclient zone showing up as an unreadable raw container id
  (e.g. `16684a3df93c`) instead of a human-readable name. Root cause:
  Snapcast's zone display name falls back to the client's raw hostname
  when no name has been explicitly set, and nothing ever set one.
  `snapclient --hostID` was confirmed by hand to NOT fix this — it only
  overrides the client's unique id, not its display name. Fixed by
  pinning `--hostID` to a fixed sentinel (`image-snapclient`'s
  entrypoint, requires the `signalk-jukebox-snapclient:latest` image
  republished with this change) purely so the plugin can find this one
  deterministic zone once it connects, then calling Snapcast's own
  `Client.SetName` on it with the configured `zoneName`.

## [0.0.5] - 2026-08-23

### Added

- `GET /api/satellites` — known `voice.satellites.<id>` ids, backing the
  config panel's satellite dropdown.
- The config panel's per-satellite duck-mapping rows now use dropdowns
  (populated from `/api/satellites` and `/api/zones`) instead of free-text
  fields for satellite id and zone id.

### Fixed

- Config panel's image-version dropdown showing "⚠ Could not reach GitHub
  — showing last known versions, retry" (and the retry button not
  helping) on every install. Root cause: `GET /api/versions` was never
  actually implemented — a stale comment claimed
  `ManagedContainer.registerUpdateRoutes` provided it, but that helper
  only covers the single latest-version check/apply flow. The request
  fell through to the plugin's catch-all Mopidy proxy, which returned a
  non-2xx response the UI library reports with that exact (misleading —
  it isn't specific to GitHub reachability) hardcoded message. Now backed
  by a real route (`src/ghcr-versions.ts`) that lists tags from
  `ghcr.io/boathacks/signalk-jukebox` directly.

## [0.0.4] - 2026-08-23

### Added

- `.github/workflows/plugin-ci.yml`: SignalK's standard reusable
  plugin-CI workflow, cross-testing on Linux x64/arm64, macOS, Windows,
  and armv7/Venus-OS (Cerbo). Avoids a flat -10 penalty on the SignalK
  plugin registry's published score.
- `.github/workflows/publish.yml`: npm OIDC trusted publishing —
  releases now publish automatically on `gh release create`, no
  NPM_TOKEN or interactive OTP required.

### Fixed

- The container's wait for `signalk-container` to register (on `stop()`
  in particular) no longer blocks for the full default 120s when that
  plugin isn't present — shortened to 20s. Confirmed via SignalK's
  plugin-CI lifecycle check, whose mock server has no `signalk-container`
  at all: the 120s wait collided with the check's own 2-minute step
  timeout across its start/stop/start/stop sequence.

## [0.0.3] - 2026-08-23

### Changed

- npm package description now leads with an experimental/untested warning,
  so it's visible immediately in the SignalK app store listing. Also
  dropped a stale reference to Mopidy-Iris (replaced by the built-in
  web UI, `image/webui`).

## [0.0.2] - 2026-08-23

### Added

- Four momentary playback-control SignalK paths,
  `entertainment.jukebox.playback.controls.{play,pause,next,previous}`,
  for mapping a physical pushbutton (or any delta source) to playback
  control: send `1` on press, `0` on release; the plugin fires the
  matching action on each press edge.
- PUT handlers for `playback.volume`, `zones.<id>.volume`, and
  `zones.<id>.muted` — these paths were documented as "PUT-able" since
  the first release but nothing actually implemented `registerPutHandler`
  for them; they only ever worked via the REST API.

### Fixed

- Config panel crash (`Cannot read properties of undefined (reading
'enabled')`) on a partially-populated saved config, e.g. one saved
  before a later settings group was added.

## [0.0.1] - 2026-08-22

First release. Containerized whole-boat music playback for SignalK:
Mopidy + Snapcast multi-zone audio, per-zone AirPlay receivers, NMEA2000/
Fusion-Link interop, and a custom Admin config panel, all sharing one
live playback/zone state.

### Added

- Containerized Mopidy (local files / internet radio / Spotify) +
  Snapserver in one image, managed via `ManagedContainer`.
- Multi-zone audio via Snapcast; zones auto-discovered read-only, with
  per-zone volume/mute and a source picker (which zones play the shared
  Jukebox stream, or "everywhere" at once).
- A minimal built-in web UI (`image/webui`), reverse-proxied through the
  plugin, standing in for Mopidy-Iris until it's compatible with Mopidy
  4.x (tracked upstream, unresolved: jaedb/Iris#999).
- Per-zone AirPlay receivers, created/removed on demand as a phone
  connects/disconnects — requires opting into host networking
  (`airplay.hostNetworking`, off by default; see the README's security
  note) for AirPlay to actually be discoverable/reachable on the LAN.
- An optional "local snapclient" — a second managed container running a
  Snapclient zone on the SignalK server's own sound card, for boats with
  speakers wired directly to that machine.
- Best-effort NMEA2000/Fusion-Link emulation, riding SignalK's own
  already-claimed bus address (no dedicated CAN hardware required) —
  whether real MFDs respond usefully to this is unverified against real
  hardware.
- Two duck triggers: VHF radio traffic pauses playback boat-wide; voice-
  assistant activity (signalk-wyoming) ducks zone volume, with optional
  per-satellite zone mapping.
- A custom Admin config panel (`signalk-container-helper/ui`) alongside
  the standard JSON-schema fallback form.

### Known limitations

- Untested on an actual vessel — see the README's status note.
- Spotify playback is degraded upstream (mopidy-spotify#437, an open
  login5 auth issue as of this writing) — the backend is wired up
  correctly but basic playback may not authenticate.
- NMEA2000/Fusion-Link MFD compatibility is unverified against real
  hardware.
- AirPlay requires host networking (see the README's security note) —
  no macvlan/mDNS-reflector alternative was found that actually works
  given this project's container-runtime constraints.
