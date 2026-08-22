# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
