# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
