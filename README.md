# signalk-jukebox

Whole-boat music playback for [Signal K](https://signalk.org): a
containerized [Mopidy](https://mopidy.com/) music server (local files +
optional internet radio / Spotify), multi-zone audio via
[Snapcast](https://github.com/snapcast/snapcast), and NMEA2000/Fusion-Link
interop for existing chartplotters — all sharing one live playback/zone
state across every interface (web, REST, N2K).

See [SPEC.md](SPEC.md) (what/why) and [ARCHITECTURE.md](ARCHITECTURE.md)
(how) for the full design, including open risks still being tracked
(SPEC.md §13).

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
