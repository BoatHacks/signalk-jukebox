# signalk-jukebox

Whole-boat music playback for [Signal K](https://signalk.org): a
containerized [Mopidy](https://mopidy.com/) music server (local files +
optional internet radio / Spotify), multi-zone audio via
[Snapcast](https://github.com/snapcast/snapcast), per-zone AirPlay
receivers, and NMEA2000/Fusion-Link interop for existing chartplotters —
all sharing one live playback/zone state across every interface (web,
REST, N2K).

**Status: early scaffold.** See [SPEC.md](SPEC.md) (what/why) and
[ARCHITECTURE.md](ARCHITECTURE.md) (how) for the full design — including
two open risks that haven't been tested against real hardware yet:
whether Fusion-Link-aware MFDs respond usefully to this plugin's
best-effort broadcasts (SPEC.md §13), and the exact mechanism for
regenerating Snapserver config on a brand-new zone's first AirPlay slot
claim (ARCHITECTURE.md §9).

Follows the `ManagedContainer` archetype from
[signalk-container-helper](https://github.com/hoeken/signalk-container-helper).

## Development

```bash
npm install
npm run build
npm test
npm run format
```

## License

Apache-2.0
