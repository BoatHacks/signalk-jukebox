# signalk-jukebox

> ⚠️ **AirPlay requires turning off this container's network isolation.**
> To make AirPlay zones discoverable and usable from an iPhone/iPad, this
> plugin has to run its container in **host networking** mode
> (`airplay.hostNetworking` in the config panel, off by default). Normally
> a container is sealed off from the rest of your system, on its own
> private network, only able to use the specific ports it's explicitly
> given — that's what keeps a bug or a compromise in one piece of software
> from spilling over into everything else running on the same machine.
> Host networking mode removes that seal completely: this container's
> processes sit directly on your boat's real network, alongside your
> SignalK server and everything else running on that machine, able to use
> any port and reach anything on the network the machine itself can reach.
> This is a real, deliberate trade — not a bug, and not something we can
> engineer around (see [SPEC.md §12](SPEC.md) for what was tried and why
> it didn't work) — but it does mean you're trusting this specific
> plugin's container with a level of access your other SignalK plugins
> don't have. Only enable it if you actually want AirPlay and accept that
> trade; leave it off otherwise.

Whole-boat music playback for [Signal K](https://signalk.org): a
containerized [Mopidy](https://mopidy.com/) music server (local files +
optional internet radio / Spotify), multi-zone audio via
[Snapcast](https://github.com/snapcast/snapcast), per-zone AirPlay
receivers, and NMEA2000/Fusion-Link interop for existing chartplotters —
all sharing one live playback/zone state across every interface (web,
REST, N2K).

**Status: first experimental release — completely untested by a human.**
The container image builds and runs, and its Mopidy/Snapserver plumbing
has been verified in isolation (build tooling, not a real boat), but
nobody has yet used this plugin end to end on an actual vessel. Expect
rough edges. See [SPEC.md](SPEC.md) (what/why) and
[ARCHITECTURE.md](ARCHITECTURE.md) (how) for the full design — including
open risks that haven't been tested against real hardware yet: whether
Fusion-Link-aware MFDs respond usefully to this plugin's best-effort
broadcasts (SPEC.md §13), and real AirPlay/Spotify playback end to end.

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
