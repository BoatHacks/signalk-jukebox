# signalk-jukebox Specification

**Status:** Draft v0.1 — pre-implementation
**Scope:** A SignalK plugin providing whole-boat music playback (local
library + optional streaming backends), delivered as a containerized
Mopidy instance via signalk-container /
[signalk-container-helper](https://github.com/hoeken/signalk-container-helper),
with multi-zone audio distribution over Snapcast.

## 1. Introduction

### 1.1 Purpose

signalk-jukebox brings music control into the same SignalK ecosystem crew
already use for navigation and boat systems — no separate phone app, no
dedicated media PC. It runs a containerized [Mopidy](https://mopidy.com/)
music server (local files + optional streaming backends), and distributes
audio to speaker zones around the boat (cockpit, salon, cabin) via
[Snapcast](https://github.com/snapcast/snapcast), with synchronized playback
and independent per-zone volume/mute.

Crew and guests must also be able to play audio straight from their own
phone onto the boat's speakers, the way AirPlay works on a home stereo —
scoped to whichever zone they're near, not the whole boat. Each zone
dynamically gets its own AirPlay receiver, discoverable by name (e.g.
"Jukebox - Cockpit"), so anyone can AirPlay to the cockpit speakers
specifically without a companion app or manual pairing. An Android-
equivalent casting target (Chromecast/Bluetooth/DLNA — undecided, §13)
is a deferred, not abandoned, follow-on (§10.2).

Playback must also be controllable from hardware already on many boats:
NMEA2000 stereo head units and Fusion-Link-aware chartplotters (Garmin
MFDs in particular). signalk-jukebox emulates a Fusion stereo on the N2K
bus and broadcasts standard NMEA2000 entertainment PGNs, so an MFD at the
helm can show now-playing and control volume/transport/zone the same way
it would for a real Fusion unit — with no distinction to the user between
"the boat has a Fusion stereo" and "the boat has signalk-jukebox."

Every interface — Iris (web), the REST API, NMEA2000/Fusion-Link, and the
SignalK Admin panel — is a view onto **one shared, live playback and zone
state**. A volume change from the MFD, from Iris, or from a REST call
are equivalent: the state updates once, and every other interface reflects
it immediately. No interface is a passive mirror of another; they are all
peers reading and writing the same canonical state (see §3, §12).

The primary human control surfaces are Mopidy's own web client, reverse-
proxied through the SignalK server, and any Fusion-Link-compatible MFD
already on the boat. The intended web client is
[Iris](https://github.com/jaedb/Iris) (§12); as of this writing it ships
as a minimal hand-rolled substitute instead, because Iris isn't compatible
with the Mopidy version this project currently requires (§12, §13) — swap
back once that's resolved upstream. The plugin's own SignalK Admin config
panel handles container lifecycle, image updates, N2K/Fusion
configuration, and zone volume/mute — it is not a player.

### 1.2 Background

This plugin follows the `ManagedContainer` archetype documented in
signalk-container-helper's README (the `signalk-backup` / `mayara-server`
pattern: the plugin owns its container's full lifecycle). It is a sibling
project to [signalk-wyoming](https://github.com/hoeken/signalk-wyoming),
which handles voice (TTS/STT/wake-word) for the boat. signalk-wyoming's
own spec explicitly lists music/media playback and multiroom audio sync as
**non-goals** — signalk-jukebox is the project that fills that gap. The
two are complementary: signalk-wyoming's SPEC also lists "Snapcast as an
announce target" as a stretch goal, meaning voice announcements could one
day duck into the same Snapcast zones this plugin creates (see §13 Open
Questions).

### 1.3 Terminology

- **Zone** — an independently controllable audio destination on the boat
  (e.g. "Cockpit", "Salon"), realized in MVP as one Snapclient device, and
  optionally also exposed as one numbered N2K/Fusion-Link zone (§2, §6.3).
- **Snapserver** — the process that receives Mopidy's audio output and
  distributes it, time-synchronized, to Snapclients.
- **Snapclient** — a device (Pi, amp with Snapcast support, etc.) at a
  speaker zone that receives and plays the synced audio stream. Deployed
  and managed independently of this plugin (§1.4 non-goals).
- **Backend** — a Mopidy extension providing a source of playable media
  (local files, internet radio, Spotify, etc.).
- **PGN** — Parameter Group Number, an NMEA2000 message type identifier.
  "Entertainment PGNs" are the PGN range NMEA has published for
  audio-entertainment devices (now-playing, zone/volume status, transport
  control), distinct from Fusion's own proprietary PGNs (below).
- **Fusion-Link** — Fusion's (Garmin-owned) proprietary NMEA2000-based
  protocol for their stereo product line. Not officially published; the
  plugin implements it against the community-documented, reverse-engineered
  protocol (§6.3, §13 — protocol-drift risk noted there). Most
  Fusion-Link-_aware_ chartplotters in practice speak this, not the
  generic NMEA "Entertainment" PGN set. **Best-effort emulation**: the
  plugin broadcasts Fusion PGNs under the SignalK server's own N2K
  identity (§6.3, §12) rather than claiming a distinct bus address of
  its own — see §13 for what this does and doesn't guarantee.
- **Canonical state** — the single in-plugin source of truth for playback
  and zone state that every interface (Mopidy, N2K/Fusion, REST, SK paths)
  reads from and writes to (§3, §12).
- **AirPlay receiver** — a Snapcast `airplay`-type stream created
  on-demand for one zone the moment it connects, and removed the moment
  it disconnects (§2, §6.4). No pool, no slot numbering, no persisted
  assignment — unlike `n2kZone` (below), a zone's AirPlay receiver has no
  identity that needs to survive across connects.
- **Active source** — which audio feed (the Jukebox/Mopidy stream, or
  that zone's own AirPlay receiver) a given zone's Snapclient group is
  currently attached to. Distinct from _master_ playback state, which
  is Mopidy-specific (§4).
- **Duck trigger** — a SignalK delta path signalk-jukebox subscribes to
  (published by another plugin, not this one) that automatically pauses
  or lowers playback volume while active, and restores it afterward
  (§2, §6.5). Entirely optional — a duck trigger whose source path never
  appears (the other plugin isn't installed) simply never fires; this
  plugin has no hard dependency on either one existing.

### 1.4 Non-goals (v1)

- Deploying or managing Snapclient hardware/containers — zones are
  external, this plugin only runs the Snapserver side (see ARCHITECTURE.md
  §5 for the boundary).
- A custom playback control UI beyond Iris and the Fusion-Link/N2K surface
  — the plugin's own Admin panel is status/config only.
- Streaming audio to wyoming-satellite devices (mic/speaker boxes deployed
  for voice) — documented as a future interop question (§13), not built.
- Synthesizing, routing, or playing announcement audio itself — that
  remains entirely signalk-wyoming's domain. This plugin only reacts to
  signalk-wyoming's published state to duck its own playback (§2, §6.5);
  it never touches announcement audio.
- Multi-user accounts, playlists-per-user, or any per-crew-member
  personalization — one shared jukebox per boat.
- Cloud-hosted or off-boat deployments — this assumes Mopidy runs on the
  boat's own SignalK host alongside signalk-container.
- Emulating any N2K entertainment device other than Fusion — no CZone,
  Garmin-native, or other manufacturer's proprietary protocol in v1.
- **The plugin owning its own CAN/N2K gateway hardware, or performing its
  own NMEA2000 ISO address claiming.** It rides SignalK's already-
  configured N2K provider and the SK server's own claimed bus address
  (§2, ARCHITECTURE.md §5) — confirmed deliberate (not an oversight)
  after research (§13) showed the alternative (a dedicated,
  address-claiming canboatjs device, as e.g.
  `RaymarineAPtoFakeNavicoAutoPilot` does) needs direct CAN interface
  access this plugin isn't taking on. The practical consequence — the
  plugin is not a fully bus-recognized "device," it broadcasts under an
  existing one — is accepted as a known limitation, not solved (§6.3,
  §13).
- **Android-equivalent casting** — deferred, not rejected (§10.2, §13).
  Chromecast, Bluetooth A2DP, and DLNA/UPnP are all real candidates with
  different tradeoffs (mature receiver software, hardware passthrough
  needs, and discoverability all differ); revisit once AirPlay's
  per-zone model is proven out.

## 2. Domain Rules — Backend & Zone Behavior

- **Backends are optional and independently toggleable.** Local files,
  internet radio, and Spotify are all present in the container image, but
  each is enabled/disabled and configured from the plugin's Admin config
  panel. A disabled backend must not appear in Iris and must not block
  Mopidy startup if misconfigured (e.g. no Spotify credentials entered).
- **Zones are read-only discovered, not manually provisioned.** The
  plugin does not create Snapclients; it lists whatever Snapclients are
  currently connected to its Snapserver and exposes volume/mute for each.
  A zone that disconnects drops off the list; one that reconnects
  reappears.
- **Discovered zones get a stable N2K/Fusion zone number.** Fusion-Link
  and the NMEA "Entertainment" PGNs both address zones by small integer
  (typically 0–3, i.e. up to 4 zones). The first zone a Snapclient is
  ever seen at is assigned the next free N2K zone number and that
  assignment is persisted (§8) — so "Zone 1" on the MFD always means the
  same physical Snapclient across restarts and reconnects, even though the
  zone list itself (§ above) stays live/discovered. A 5th+ Snapclient is
  still a full zone on Iris/REST/web, just without an N2K zone slot.
- **All interfaces are peers over one canonical state, not a chain of
  mirrors.** A write from any interface (Iris → Mopidy, an MFD's
  Fusion-Link volume knob, a REST `POST`) updates the canonical playback/
  zone state (§3, §4) once; every other interface observes that same
  update. There is no "source of truth interface" — Mopidy is one
  adapter among several, not privileged over N2K/Fusion or REST. Last
  write wins on concurrent updates to the same field; see §12 for why.
- **The library mount is read-only.** The plugin never writes into the
  user's music folder; Mopidy only needs read access to scan and stream
  local files.
- **VHF radio traffic pauses playback boat-wide.** Watching
  `communication.vhf.busy` (published by the `htool` ICOM VHF plugins,
  confirmed real — SPEC.md §13; a boolean, receive-side only, see the
  caveat below), the plugin pauses Mopidy playback the moment it goes
  `true` and resumes it `vhf.resumeDelaySeconds` (default 5, §9) after it
  goes `false` — **only if the plugin itself paused it**; a pause the
  user issued manually (via Iris/REST/N2K) during or before the busy
  period is never auto-resumed, so the plugin doesn't fight the user
  (§4 tracks this distinction). This is boat-wide, not per-zone, on the
  reasoning that radio traffic is safety-relevant and may need to be
  heard anywhere aboard (§12). **Caveat, confirmed via research (§13):**
  `communication.vhf.busy` only reflects incoming channel activity
  (squelch opening) — there is no path for your own outgoing
  transmission (PTT) in either source plugin, so this only ducks for
  calls you're receiving, not ones you're making.
- **Voice-assistant activity ducks (lowers, doesn't pause) playback, with
  an opt-in per-zone target.** Watching signalk-wyoming's own
  `voice.satellites.<id>.state` paths (if installed — another optional,
  not-required integration), the plugin lowers volume while any
  satellite is non-`idle` and restores it once that satellite returns to
  `idle`, following the precedent of
  [FutureProofHomes' wyoming-enhancements](https://github.com/FutureProofHomes/wyoming-enhancements)
  project (§12) — a volume dip under continuing audio, not a stop, since
  voice interactions are typically short and the point is intelligibility
  during them, not a hard interruption. **Target zones per satellite**
  (§9's `voiceDucking.satelliteZoneMap`): if the active satellite has a
  configured mapping entry, only its mapped zone is ducked; if it has no
  entry, **all zones** are ducked (the safe default, unmapped) for as
  long as that satellite is active. Multiple simultaneously-active
  satellites union their target zone sets. Configuring the mapping is
  optional and manual (§13) — there's no auto-detection of which
  Snapclient physically sits with which satellite.
- **Every zone gets its own AirPlay receiver, created the moment it
  connects and removed the moment it disconnects (§6.4).** Confirmed via
  research (§13) that Snapcast ≥ 0.33.0's control API can both create and
  cleanly remove `airplay`-type streams at runtime — the earlier belief
  that this was blocked was version-specific, not a permanent Snapcast
  property, and this plugin pins its own Snapserver version so requiring
  ≥ 0.33.0 costs nothing. No pool, no cap, no persisted slot assignment:
  a zone's receiver is created with the zone's real name from the start.
  This is per-zone, not boat-wide — someone can AirPlay to the cockpit
  specifically while the salon keeps playing the Mopidy queue.
- **An active AirPlay session on a zone takes over that zone's audio,
  replacing whatever the Jukebox source was sending it**, for as long as
  the session is connected; when it ends, the zone reverts to whatever
  the Jukebox source (Mopidy) is currently playing. This mirrors how a
  real AirPlay-receiving stereo behaves — the incoming AirPlay stream
  simply becomes what plays, no explicit "switch back" step needed.
  Other zones are unaffected by one zone's AirPlay session.

## 3. State / Lifecycle Model

### 3.1 State Definitions

Container/plugin lifecycle follows the standard `ManagedContainer` states
(see signalk-container-helper README) — not restated here. What's specific
to this plugin:

- **Playback state** (canonical, §4): `stopped | playing | paused`.
- **Zone connection state**: `connected | disconnected` per Snapclient, as
  reported by Snapserver.
- **N2K/Fusion device state**: `unclaimed | claimed` — whether the plugin
  has successfully claimed an NMEA2000 source address for its emulated
  Fusion device (ARCHITECTURE.md §2, SPEC.md §13). Only meaningful when
  the N2K/Fusion interface is enabled (§9).
- **Zone active source**: `jukebox | airplay` per zone — which feed that
  zone's Snapclient group is currently attached to (§2).

### 3.2 Transitions

Playback state is **not owned by any single interface** — it is owned by
the canonical state store (§4, ARCHITECTURE.md §2), and any adapter
(Mopidy, N2K/Fusion, REST) can drive a transition:

- Iris issuing a Mopidy command, a REST `POST`, or an incoming Fusion-Link
  transport command (play/pause/skip) all update canonical state the same
  way: the adapter that originated the command applies it to Mopidy (the
  actual audio engine) _and_ to canonical state; the other adapters are
  notified of the resulting state change and update their own outward
  representation (SK path delta, outgoing PGN broadcast, etc.) — they do
  not re-derive it independently.
- Mopidy remains the one place that actually produces audio, so every
  transport/volume command — regardless of which interface it arrived
  through — is ultimately applied to Mopidy. Canonical state reflects
  Mopidy's resulting state, confirmed via Mopidy's own event stream
  (`playback_state_changed`, `volume_changed`, etc.), not assumed
  optimistically from the command that was sent.
- Zone connection state transitions are driven by Snapclients connecting
  to / disconnecting from Snapserver; the plugin polls Snapserver's
  control API and reflects what it reports into canonical state. Zone
  volume/mute, like playback, can be written from any interface (Iris/
  REST/N2K) and is applied to Snapserver, then confirmed back into
  canonical state.
- **Zone active source transitions are driven by AirPlay connect/
  disconnect events on that zone's claimed AirPlay slot** (§6.4), not by
  any explicit "switch source" command from another interface in MVP —
  connecting is the switch. Snapserver reports which stream a group is
  attached to, so the plugin's Snapserver adapter can detect the
  transition and reflect it into canonical state (and, if the N2K/Fusion
  interface is enabled and the zone has an `n2kZone`, broadcast it per
  §6.3's now-playing selection logic).

## 4. Data Model

These are the **canonical state** shapes — the one copy every interface
(Mopidy adapter, N2K/Fusion adapter, REST, SK paths) reads and writes
through (§3.2, ARCHITECTURE.md §2). No adapter keeps its own competing
copy.

- **PlaybackState** — `{ state: 'stopped'|'playing'|'paused', track?: { uri, name, artist?, album?, durationMs?, positionMs? }, volume: number (0-100), muted: boolean }`
  — the actual values live in Mopidy; canonical state is kept in sync via
  Mopidy's event stream, and every write to it is applied to Mopidy first
  (§3.2). `volume`/`muted` here are the _master_ volume (pre-zone), used
  for Fusion-Link's own volume model (§6.3); per-zone volume is separate
  (`Zone.volume` below).
- **Zone** — `{ id, name, connected: boolean, volume: number (0-100), muted: boolean, n2kZone?: number, activeSource: 'jukebox'|'airplay', airplay?: { streamName, connected: boolean, track?: { title, artist?, album? } } }`
  — `id` is the Snapclient's Snapcast-assigned id; `name` is whatever the
  Snapclient reports (typically its hostname) unless overridden. `n2kZone`
  (0–3) is present only for zones assigned an N2K/Fusion slot (§2, §8);
  absent for zones beyond the protocol's zone count. `airplay.streamName`
  is the mDNS name that zone's receiver advertises (e.g. "Jukebox -
  Cockpit", §9); `airplay.connected` reflects whether a device currently
  has an active AirPlay session to it; `airplay.track` is real
  title/artist/album read from that zone's `shairport-sync` **metadata
  pipe** (§6.4) — absent until the sending device/app pushes metadata
  (not universal — depends on the AirPlay source — and can lag session
  start), not an error condition.
- **QueueSnapshot** (plugin-managed persistence, see §8) — the serialized
  Mopidy tracklist + current track index + position, snapshotted
  periodically and on clean `stop()`, restored on the next container
  start.
- **ZoneAssignment** (plugin-managed persistence, see §8) — the persisted
  Snapclient-id → `{ n2kZone?: number }` mapping (§2), independent of
  whether that Snapclient is currently connected. Assigned once, the
  first time a Snapclient is seen, and never reassigned automatically
  thereafter. (AirPlay no longer needs an entry here — §6.4, §12 — since
  a zone's AirPlay receiver is created/removed on demand rather than
  claiming a persisted slot.)
- **DuckState** (plugin-internal, not persisted — §8) — `{ pausedByVhf: boolean, activeDucksBySatellite: Record<satelliteId, zoneId[]>, preDuckZoneVolumes: Record<zoneId, number> }`.
  `pausedByVhf` is what makes the VHF auto-resume rule (§2) not fight a
  manual pause; `activeDucksBySatellite` tracks which satellite(s) are
  currently ducking which zones, so a zone targeted by two overlapping
  satellite sessions stays ducked until both finish (§6.5);
  `preDuckZoneVolumes` is what voice ducking restores to, captured at the
  moment each zone starts being ducked (§2, §12 — the accepted
  simplification if a user changes a zone's volume _during_ a duck).
- **PluginSettings** — backend toggles, library path, Spotify credentials
  (if enabled), image tag, N2K/Fusion enable + device identity settings,
  duck-trigger settings. See §9.

## 5. Sources / Inputs

- **Local library** — a host folder, bind-mounted read-only into the
  container (§8/§9). If the path is missing or empty, Mopidy starts with
  an empty local library and the plugin surfaces a status warning, not a
  fatal error.
- **Internet radio** — intended via Mopidy-TuneIn (§12), currently dropped
  from the image: confirmed by build-testing that it doesn't load against
  the Mopidy version this project requires (§12, §13), the same
  incompatibility affecting Iris. Mopidy's built-in `stream` extension
  still plays any http(s) audio URL directly with no extension at all,
  which covers actual playback — only TuneIn's searchable station
  directory is lost until it (or a replacement) regains compatibility.
  Requires internet connectivity to resolve streams either way, gracefully
  unavailable when offline (boats lose connectivity — this must not be
  treated as an error state).
- **Spotify** — Mopidy-Spotify, requires a Spotify Premium account, a
  registered app's `client_id`/`client_secret` (not username/password —
  Spotify disabled that login path entirely; corrected via research,
  §13), entered in the Admin panel (§9). Unavailable offline, same as
  internet radio. **Currently degraded upstream, not just
  offline-unavailable** — as of this research (2026-08-22), Mopidy-Spotify
  has an open, unresolved upstream issue (mopidy-spotify#437) where
  Spotify's own login5 authentication rejects even valid credentials for
  third-party streaming clients; treat this backend as unreliable until
  that's resolved, not as a solid MVP feature (§13).
- **Zone list** — read from Snapserver's own control API (JSON-RPC), not
  configured by the user.
- **Duck triggers** (§6.5) — `communication.vhf.busy` and
  `voice.satellites.<id>.state`, both published by other, optional
  plugins (the `htool` ICOM VHF plugins and signalk-wyoming
  respectively). Neither is a SignalK-spec-standard path; both are
  treated as absent-by-default, not a required dependency (§2).

If a backend is unreachable (no internet, bad Spotify credentials), the
other backends continue to work — one backend's failure never blocks
Mopidy startup or the other backends.

## 6. API Specification

### 6.1 REST API

All routes under `/plugins/signalk-jukebox`, respecting SignalK access
control (read for GETs, write/admin for mutating routes, per
signalk-container-helper conventions):

| Method & path                                      | Purpose                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/status`                                  | Container/Mopidy status, current playback state          |
| `GET /api/zones`                                   | `[{ id, name, connected, volume, muted }]`               |
| `POST /api/zones/:id/volume`                       | `{ volume: 0-100 }`                                      |
| `POST /api/zones/:id/mute`                         | `{ muted: boolean }`                                     |
| `GET /api/update/check` / `POST /api/update/apply` | Image update routes (`registerUpdateRoutes`, admin-only) |
| `GET /api/versions`                                | Image version list for the config panel dropdown         |

Actual playback control (play/pause/skip/queue/search) goes through the
web client (§7) directly against Mopidy's own HTTP/JSON-RPC API — this
plugin does not proxy or re-implement it.

### 6.2 SignalK Paths / Events

Under `vessels.self`, a custom `entertainment.*` branch (outside the
SignalK schema, following the same convention signalk-wyoming uses for
`voice.*`). Like every other interface, these paths are a **view onto
canonical state** (§4) — PUTs to them apply to canonical state (and from
there to Mopidy/Snapserver) exactly like a REST call or a Fusion-Link
command would; deltas are published on every canonical-state change
regardless of which interface caused it:

| Path                                             | Value                                   | Notes                                                                              |
| ------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `entertainment.jukebox.playback.state`           | `'stopped'\|'playing'\|'paused'`        |                                                                                    |
| `entertainment.jukebox.playback.track`           | `{ name, artist?, album? }`             | Present only while playing/paused                                                  |
| `entertainment.jukebox.playback.volume`          | `number` (0-100), PUT-able              | Master volume (§4)                                                                 |
| `entertainment.jukebox.zones.<id>.connected`     | `boolean`                               |                                                                                    |
| `entertainment.jukebox.zones.<id>.volume`        | `number` (0-100), PUT-able              |                                                                                    |
| `entertainment.jukebox.zones.<id>.muted`         | `boolean`, PUT-able                     |                                                                                    |
| `entertainment.jukebox.zones.<id>.n2kZone`       | `number` (0-3), read-only               | Present only if assigned (§2)                                                      |
| `entertainment.jukebox.zones.<id>.airplay.track` | `{ title, artist?, album? }`, read-only | Present only while `activeSource` is `airplay` and metadata has arrived (§4, §6.4) |

These exist so other plugins/instruments can show "now playing" or react
to it; there is no other consumer identified yet (§13).

### 6.3 NMEA2000 / Fusion-Link Interface

Enabled/configured via §9. Two protocol surfaces, both reading and
writing the same canonical state (§4) as every other interface:

**Fusion-Link emulation (primary — full bidirectional).** The plugin
claims an NMEA2000 source address and presents itself on the bus as a
Fusion stereo, using Fusion's proprietary (reverse-engineered, community
documented — see §11, §13 for the protocol-risk caveat) message set:

- **Broadcasts:** now-playing (track/artist), transport state, master
  volume, and per-zone volume/mute for every zone with an assigned
  `n2kZone` (§2), on every canonical-state change and on a periodic
  refresh interval (so a device joining the bus mid-session still gets
  current state without waiting for the next change).
- **Accepts commands:** play/pause/next/previous, master volume set,
  per-zone volume set/mute, matching what a real Fusion head unit accepts
  from an MFD. Every accepted command is applied to canonical state via
  the same path a REST/web write would take (§3.2) — an MFD is not a
  second-class caller.
- **Source model:** the plugin presents exactly **one virtual source**
  ("Jukebox") rather than mapping Mopidy's backends (local/radio/Spotify)
  to separate Fusion sources — backend/library selection is a browsing
  concept Iris already owns, not a "flip to AM/FM/Aux" concept Fusion's
  source model was designed for (see §12 for why this was chosen over
  the alternative).

**Standard NMEA2000 Entertainment PGNs (secondary).** The plugin also
broadcasts the generic NMEA-published Entertainment PGN set (current
file/status, zone configuration/status) for any N2K display that isn't
specifically Fusion-Link-aware but does implement the standard PGNs.
Read/write parity with Fusion-Link is not guaranteed here — coverage
depends on how much of the standard PGN set real-world devices actually
implement, which is unverified (§13).

Both surfaces ride SignalK's already-configured N2K provider
(`app.emit('nmea2000out', ...)` and the corresponding PGN-in hook) —
the plugin does not open its own CAN connection (ARCHITECTURE.md §5).

**Interaction with zone active source (§2, §6.4):** while a zone's
`activeSource` is `airplay`, its broadcast volume/mute still reflects
that zone's real Snapclient volume (the AirPlay session's audio is still
routed through the same Snapclient, just from a different stream) — an
MFD's per-zone volume control keeps working regardless of source, using
Fusion-Link's genuinely per-zone volume fields (`fusionSetZoneVolume` /
`fusionVolumes`' `zone1`–`zone4`, confirmed via `@canboat/ts-pgns`, §13
— this is also the protocol-level confirmation that Fusion-Link caps at
exactly 4 zones, validating the `n2kZone` 0–3 range used throughout this
doc). Track/now-playing is a single device-wide field — **confirmed via
research, not assumed (§13): Fusion-Link's now-playing/source fields
(`fusionSetSource`, `fusionTrackName`, `fusionArtistName`,
`fusionAlbumName`) are all keyed by `sourceId`, never by zone — there is
no `fusionSetZoneSource` or per-zone track message anywhere in the
protocol, matching real Fusion hardware's own architecture (one source
distributed to zones with independent volume/EQ, not independent
per-zone source selection)** — so broadcasting Mopidy's track while a
zone is actually playing someone's AirPlay session would show something
flatly false. The fix: **if any N2K-zoned zone's `activeSource` is
`airplay`, broadcast _that zone's_ real `airplay.track` (§4, §6.4) if
metadata has arrived, falling back to a fixed placeholder ("AirPlay
Active") only if it hasn't** — real data beats a fake string whenever
it's available, which is the common case (most AirPlay sources push
metadata within a second or two of starting). **Tie-break when more than
one N2K-zoned zone is on AirPlay simultaneously** (device-wide field,
one value only): the **lowest `n2kZone` number's** track wins (§12) —
deterministic, and consistent with treating zone numbering as the stable
identity it already is elsewhere in this doc.

**Bus-identity caveat (confirmed via research, §13):** the plugin
broadcasts Fusion PGNs under the SignalK server's own already-claimed
N2K address rather than claiming a distinct address for itself as a
proper "Fusion device" (§1.4 non-goals) — a deliberate scope decision,
not an oversight. Whether Fusion-Link-aware MFDs still usefully accept
and act on these broadcasts without the plugin passing an ISO Address
Claim / Product Information challenge as its own device is **unverified
and a real risk to the whole feature**, not a cosmetic gap — see §13.

### 6.4 AirPlay Zone Receivers

**True per-zone dynamic streams — confirmed viable via research (§13),
after an earlier pre-provisioned-pool design was built around a
restriction that turned out to be version-specific and no longer
current.** Snapcast v0.33.0+ (PR #1444, "Sandbox") allows `Stream.
AddStream`/`RemoveStream` to create and cleanly remove `process`-type
streams (which `airplay` is, internally) via the control API, gated by a
`stream.sandbox_dir` executable-path containment check rather than the
earlier v0.31.0–v0.32.x type whitelist. `RemoveStream` was independently
confirmed to SIGINT the whole process group (killing `shairport-sync`
and its children, not orphaning them) and cleanly unassign — not
error — any client left on the removed stream. Since this plugin builds
and pins its own Snapserver version (ARCHITECTURE.md §2.4), there is no
compatibility burden in requiring ≥ 0.33.0. Managed entirely by the
Mopidy/Snapserver adapter (ARCHITECTURE.md §2.2) — no separate REST
surface; this is infrastructure, not something a user configures
per-zone beyond the boat-wide toggle in §9.

- **Create on zone connect:** the plugin calls `Stream.AddStream` with an
  `airplay://` URI pointing at `shairport-sync` (installed inside the
  configured `sandbox_dir`, ARCHITECTURE.md §2.4) and a `name` derived
  from `airplay.namePattern` (§9) using the zone's real name — correct
  from the start, no placeholder-then-rename step needed. The resulting
  stream's implicit group (§13) is then bound to that zone's Snapclient
  via `Group.SetClients`.
- **Remove on zone disconnect:** `Stream.RemoveStream` on that zone's
  stream id — cleanly kills `shairport-sync` and drops the mDNS
  advertisement (confirmed, above). No phantom idle receivers for
  offline zones, unlike the earlier pool design.
- **No pool, no cap, no slot numbering:** each zone gets its own stream
  created/removed on demand — there is nothing to run out of, so
  `airplay.maxZones` and `ZoneAssignment.airplaySlot` (both artifacts of
  the pool design) are removed (§4, §9, §12). `n2kZone` is unaffected —
  its 4-zone cap comes from the Fusion-Link protocol itself (confirmed,
  §13), not from anything Snapcast-related.
- **`controlscript=` deliberately not used** in the stream URI — a known,
  currently-open Snapcast bug (#1455) leaks that auxiliary process on
  removal. Not needed anyway: `shairport-sync`'s metadata pipe
  (`--metadata-pipename`, below) is independent of the stream URI's
  `controlscript` parameter.
- **Naming collisions:** if two zones would produce the same advertised
  name (e.g. duplicate zone names), the plugin must disambiguate (e.g.
  append the Snapclient id) rather than silently advertise two identical
  AirPlay targets — exact scheme TBD at implementation time.
- **Metadata pipe:** each zone's `shairport-sync` is launched with
  `--metadata-enable` pointed at a per-zone named pipe. The plugin tails
  that pipe, parses `shairport-sync`'s documented DAAP-tagged metadata
  format, and writes `title`/`artist`/`album` into that zone's
  `Zone.airplay.track` (§4) as they arrive — feeding both the zone-level
  SK path (§6.2) and, for N2K-zoned zones, the Fusion-Link broadcast
  (§6.3). Not every AirPlay source sends metadata, and it can lag session
  start by a second or two; both cases just mean `track` stays absent
  until (or unless) something arrives, not an error.

### 6.5 Duck Triggers

Two independent, optional subscriptions to external SignalK deltas —
neither requires the other plugin to exist; a missing path just means
that trigger never fires (§2). Both are implemented as plain delta
subscribers writing to canonical state via the normal write path (§3.2),
not a bespoke cross-plugin API — chosen specifically to avoid coupling
this plugin's behavior to another plugin's API surface/version (§12).

**VHF (`communication.vhf.busy` → boat-wide pause, §2):**

- On `true`: if not already paused, call Mopidy `pause()` and set
  `DuckState.pausedByVhf = true`.
- On `false`: after `vhf.resumeDelaySeconds`, if `pausedByVhf` is still
  `true` (i.e. nothing else changed playback in the meantime — see §12
  for why this check exists), call Mopidy `play()` and clear the flag.
- If a manual pause/play command arrives while `pausedByVhf` is `true`,
  clear the flag without altering the manual command's effect — the user
  just took over.

**Voice (`voice.satellites.<id>.state` → per-satellite-mapped, or
all-zone fallback, volume duck, §2):**

- A satellite's **target zones** = the `zoneId` from the
  `voiceDucking.satelliteZoneMap` entry matching its `satelliteId`, if
  present, else every known zone (the unmapped fallback).
- On a satellite transitioning to a non-`idle` state: for each of its
  target zones not already ducked by some other active satellite,
  capture its current volume into `preDuckZoneVolumes` and lower it to
  `voiceDucking.duckVolumePercent` (§9) via `Client.SetVolume`
  (confirmed dynamic, no restart — SPEC.md §13). Records that satellite
  as currently ducking its target zones (`DuckState.activeDucksBySatellite`,
  §4).
- On a satellite returning to `idle`: after
  `voiceDucking.resumeDelaySeconds` (§9), drop it from
  `activeDucksBySatellite`; for each of its former target zones no
  longer targeted by any _other_ still-active satellite, restore the
  zone's volume from `preDuckZoneVolumes` and clear that entry. A zone
  targeted by two simultaneously-speaking satellites therefore stays
  ducked until both finish, not just the first to end.
- A zone the user manually changed the volume of _during_ a duck has
  that change overwritten on restore — an accepted simplification (§12),
  not solved.

## 7. User Interface

- **Web client** — reverse-proxied at `/signalk-jukebox` (or similar), the
  primary and only playback control surface. The intended client is
  **Iris** (§12): search, browse library, queue, playlists, no
  SignalK-specific modifications needed. Currently substituted with a
  minimal hand-rolled UI (`image/webui`) — confirmed by build-testing that
  Iris doesn't load against the Mopidy version this project requires
  (§12, §13) — offering only transport controls, volume, and a "play this
  URI" box, with no search/browse/queue/playlist management. Swap back to
  Iris once it publishes a compatible release.
- **SignalK Admin config panel** (this plugin, using
  `signalk-container-helper/ui` building blocks) — container status card,
  image-version dropdown + update controls, backend enable/disable
  toggles + backend-specific settings (library path, Spotify
  credentials), and a read-only zone list with per-zone volume slider and
  mute toggle. Not a playback UI.

## 8. Persistence

- **Mopidy config, library scan cache, backend state** — persisted via
  `signalkDataMount` (the container's data volume), survives container
  recreation. For Spotify specifically (§5, §13): Mopidy-Spotify's
  librespot credentials cache (`credentials.json`), which the current
  upstream workaround for its login5 issue depends on, must live in this
  same mount — losing it on container recreation would mean re-running
  whatever manual credential-generation workaround Spotify's current
  breakage requires, every time.
- **Queue/playback position** — plugin-managed: the plugin polls Mopidy's
  JSON-RPC API periodically (and on clean `stop()`) and snapshots the
  current tracklist + track index + position into the same data volume;
  on the next container start, the plugin restores it via JSON-RPC calls
  before signaling ready. See ARCHITECTURE.md §2 for the mechanism.
- **Zone volume/mute** — not persisted by this plugin; Snapserver/Snapcast
  own that state on their own restart semantics.
- **Zone → N2K zone number assignment** (§2, §4 `ZoneAssignment`) — must
  survive restarts (that's the entire point — "Zone 1" on the MFD staying
  stable), persisted in the same data volume, keyed by Snapclient id.
- **Music library files** — never written by this plugin or the
  container; read-only bind mount (§5, §9).

## 9. Configuration

| Setting                                       | Default                         | Notes                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libraryPath`                                 | — (required for local playback) | Host folder bind-mounted read-only via `resolveMount()`                                                                                                                                                                                                                                                                                     |
| `backends.local.enabled`                      | `true`                          |                                                                                                                                                                                                                                                                                                                                             |
| `backends.radio.enabled`                      | `false`                         | Internet radio; TuneIn (§12) is currently dropped from the image pending Mopidy-4 compatibility (§13) — direct http(s) stream URIs still play via Mopidy's built-in `stream` extension. Requires internet connectivity, no credentials needed                                                                                               |
| `backends.spotify.enabled`                    | `false`                         | See the reliability caveat in §5 before enabling — currently degraded upstream                                                                                                                                                                                                                                                              |
| `backends.spotify.clientId` / `.clientSecret` | —                               | Corrected via research (§13) — Mopidy-Spotify v5.0.0+ requires a registered app's OAuth client credentials, not username/password, which Spotify disabled for third-party login entirely                                                                                                                                                    |
| `imageTag`                                    | `auto`                          | Standard container-helper update-tracking convention                                                                                                                                                                                                                                                                                        |
| `n2k.enabled`                                 | `false`                         | Master toggle for the N2K/Fusion-Link interface                                                                                                                                                                                                                                                                                             |
| `n2k.deviceName`                              | `"Jukebox"`                     | Presented as the Fusion device's name on the bus                                                                                                                                                                                                                                                                                            |
| `n2k.deviceInstance`                          | `0`                             | NMEA2000 device instance, in case a boat somehow runs two jukebox-like devices                                                                                                                                                                                                                                                              |
| `airplay.enabled`                             | `true`                          | Master toggle for per-zone AirPlay receivers (§6.4)                                                                                                                                                                                                                                                                                         |
| `airplay.namePattern`                         | `"{boatName} - {zoneName}"`     | mDNS name template a zone's receiver is created with; `{boatName}` sourced from SignalK's own vessel name where available                                                                                                                                                                                                                   |
| `airplay.hostNetworking`                      | `false`                         | Required for AirPlay to actually be discoverable/reachable from real devices (§6.4, §12) — switches the container to `networkMode: host`. Off by default; the operator explicitly opts in                                                                                                                                                   |
| `vhf.enabled`                                 | `true`                          | Master toggle for the VHF pause trigger (§6.5); harmless if no VHF plugin is installed — the path just never fires                                                                                                                                                                                                                          |
| `vhf.resumeDelaySeconds`                      | `5`                             | Delay after `communication.vhf.busy` clears before auto-resuming                                                                                                                                                                                                                                                                            |
| `voiceDucking.enabled`                        | `true`                          | Master toggle for the voice-activity duck trigger (§6.5)                                                                                                                                                                                                                                                                                    |
| `voiceDucking.duckVolumePercent`              | `20`                            | Zone volume (0-100) while any voice satellite is active                                                                                                                                                                                                                                                                                     |
| `voiceDucking.resumeDelaySeconds`             | `1`                             | Delay after a satellite returns to `idle` before restoring its target zones' volume                                                                                                                                                                                                                                                         |
| `voiceDucking.satelliteZoneMap`               | `[]`                            | Optional array of `{ satelliteId, zoneId }` pairs (§2, §6.5) -- an array of pairs, not a keyed map, confirmed by build-testing: the Admin UI's schema-form library doesn't render a free-form `additionalProperties` map at all, but does render an editable array-of-objects list. Satellites with no entry duck all zones (safe fallback) |
| `localSnapclient.enabled`                     | `false`                         | Runs a second, optional managed container (`local-snapclient.ts`, §12) -- a Snapclient zone on this SignalK server's own sound card, for speakers wired directly to that machine rather than a separate physical device                                                                                                                     |
| `localSnapclient.soundCard`                   | `""`                            | ALSA device string (e.g. `plughw:CARD=wm8960soundcard,DEV=0`); required when enabled, no "auto" fallback -- a bare "default" device is ambiguous on a host with more than one sound card and fails outright (confirmed by build-testing)                                                                                                    |
| `localSnapclient.tag`                         | `"auto"`                        | Image tag for `ghcr.io/boathacks/signalk-jukebox-snapclient`, this project's own minimal Snapclient-only image                                                                                                                                                                                                                              |

## 10. MVP Scope

### 10.1 MVP Features

- Containerized Mopidy (local files backend) + Snapserver in one image,
  managed via `ManagedContainer`.
- Local library via read-only bind mount (`resolveMount`).
- Internet radio and Spotify backends, both optional/toggleable from the
  Admin panel.
- Web client reverse-proxied as the control surface — currently the
  minimal built-in UI, Iris once compatible (§7, §12).
- Multi-zone audio via Snapcast; zones auto-discovered (read-only list +
  volume/mute) in the Admin panel.
- Plugin-managed queue/position snapshot + restore across restarts.
- A canonical shared-state store (§3, §4, ARCHITECTURE.md §2) that the web
  client/Mopidy, REST, SK paths, and N2K/Fusion all read and write
  through.
- Basic `entertainment.jukebox.*` SignalK paths (§6.2), PUT-able.
- NMEA2000/Fusion-Link interface (§6.3): Fusion stereo emulation
  (broadcast + accept commands), stable zone-to-N2K-zone mapping, plus
  the standard NMEA2000 Entertainment PGN set on a best-effort basis.
- Per-zone AirPlay receivers (§6.4): dynamically provisioned/torn down
  with each zone, replacing that zone's audio while a session is active,
  reverting to the Jukebox source when it ends.
- Duck triggers (§6.5): boat-wide pause on `communication.vhf.busy`,
  all-zone volume duck on `voice.satellites.*.state`, both optional and
  degrading silently when their source path never appears.
- Standard container-helper update flow (version dropdown, check/apply).

### 10.2 Post-MVP / Deferred

- **Deploying/managing Snapclients** — out of scope entirely for now; may
  never be in scope (boats already have varied speaker hardware).
- **wyoming-satellite as a playback zone type** — documented interop
  question (§13), not implemented; would need a second zone backend type
  and a stable wyoming-satellite control-API contract to build against.
- **Direct NAS/SMB access from Mopidy** — MVP requires the host path to
  already be mounted; Mopidy's SMB extension could remove that
  requirement later.
- **Custom control UI beyond Iris** — not planned unless Iris proves
  insufficient in practice.
- **Producing or routing announcement audio itself** — synthesizing and
  playing TTS audio into zones remains signalk-wyoming's domain entirely.
  What _is_ in scope (§2, §6.5): signalk-jukebox reacting — ducking or
  pausing its own playback — to signalk-wyoming's and other plugins'
  already-published SignalK state, without ever handling their audio.
- **Android-equivalent casting** (Chromecast/Bluetooth/DLNA, §1.4) —
  deferred until the per-zone AirPlay model above is built and proven;
  which specific target to build depends partly on how AirPlay's
  per-zone dynamic provisioning holds up in practice.
- **AirPlay now-playing metadata surfaced to N2K/Fusion or SK paths** —
  MVP only handles audio routing for AirPlay sessions, not showing
  track/artist from someone's phone on the MFD or in Iris (§6.3's noted
  gap).

## 11. References

- [signalk-container-helper](https://github.com/hoeken/signalk-container-helper) — the `ManagedContainer` archetype this plugin follows.
- [signalk-wyoming](https://github.com/hoeken/signalk-wyoming) — sibling voice-assistant plugin family; its SPEC.md documents the non-goal/stretch-goal boundary referenced in §1.2.
- [Mopidy](https://mopidy.com/) / [Mopidy-Spotify](https://github.com/mopidy/mopidy-spotify) / [Iris](https://github.com/jaedb/Iris)
- [Snapcast](https://github.com/snapcast/snapcast)
- [@canboat/ts-pgns](https://github.com/canboat/ts-pgns) — structured PGN
  definitions (v1.11.18 checked) confirming Fusion-Link's actual
  zone/source field layout (§6.3, §12, §13): per-zone volume
  (`fusionSetZoneVolume`, `fusionVolumes`), device-wide source/now-playing
  (`fusionSetSource`, `fusionTrackName`/`fusionArtistName`/
  `fusionAlbumName`, all keyed by `sourceId` not zone).
- [FutureProofHomes/wyoming-enhancements](https://github.com/FutureProofHomes/wyoming-enhancements) —
  the researched precedent for voice-activity ducking (§6.5, §12): a
  wake-word `--detection-command`/`--tts-stop-command` pair that dips and
  restores a PulseAudio sink's volume around a voice interaction. The
  mechanism this project adapts is "duck via volume, not stream-swap";
  their implementation runs the Snapcast client and Wyoming satellite
  colocated on one PulseAudio device, which this plugin's design doesn't
  assume (§13).
- [htool/signalk-icom-m510e-plugin](https://github.com/htool/signalk-icom-m510e-plugin) and
  [htool/signalk-icom-ct-m500-plugin](https://github.com/htool/signalk-icom-ct-m500-plugin) —
  source of the confirmed `communication.vhf.busy` path (§6.5, §13).
- [Canboat](https://github.com/canboat/canboat) — the community-maintained
  NMEA2000 PGN definition database; source for the standard Entertainment
  PGN definitions (§6.3) and a common reference point for reverse-engineered
  Fusion PGNs.
- Fusion-Link protocol — not officially published by Fusion/Garmin; the
  implementation target is whatever community reverse-engineering (e.g.
  existing open-source Fusion-NMEA2000 integrations) documents at
  implementation time. Verify against the actual current state of that
  documentation before building §6.3, not from memory (§13).

## 12. Design Decisions

- **Iris over a custom UI** — Mopidy already has a mature, actively
  maintained web client with search/browse/queue/playlist management.
  Building a competing UI would be pure duplication for no boat-specific
  benefit; the plugin's job is container lifecycle and zone control, which
  Iris doesn't do. **Currently superseded by necessity, not by choice**
  (§13): confirmed by build-testing that Iris (and Mopidy-TuneIn) still
  call Mopidy-3-era internals (`mopidy.internal`, `mopidy.models.serialize`)
  that Mopidy 4.x removed, and Iris tracks this as an open, unresolved
  upstream issue ([jaedb/Iris#999](https://github.com/jaedb/Iris/issues/999)).
  Since this project's Mopidy-Spotify dependency (§5) needs Mopidy ≥4.0,
  Iris is temporarily replaced with a minimal hand-rolled substitute
  (`image/webui` — a small custom Mopidy extension serving transport/
  volume/play-URI controls against Mopidy's existing JSON-RPC, using the
  same `http:app` registry mechanism Iris itself uses) rather than
  blocking on an upstream fix with no ETA. Swap back once Iris publishes a
  Mopidy-4-compatible release — nothing about this plugin's own state
  store or interfaces depends on which web client is mounted.
- **Combined Mopidy+Snapserver image over two containers** — one
  `ManagedContainer` instance, one lifecycle, no inter-container network
  wiring to get wrong; matches the precedent set by signalk-wyoming's
  purpose-built satellite image for a similarly "glue two upstream
  processes together" problem.
- **Snapcast over raw ALSA/PulseAudio passthrough** — a single-zone
  passthrough model can't do multi-zone without either duplicating
  containers per zone or writing custom audio routing; Snapcast is
  purpose-built for exactly this (one source, N synced sinks, per-sink
  volume) and existing Snapclient hardware/images already exist for
  boaters to deploy independently.
- **Plugin-managed queue snapshot over Mopidy-native persistence** — Mopidy
  can restore its last tracklist via its own config, but going through
  the plugin's own snapshot/restore (via JSON-RPC) keeps that state
  visible to the plugin (for future SignalK path/status use) rather than
  opaque inside Mopidy's internal storage, at the cost of a small amount
  of polling/restore code.
- **Fusion-Link emulation rides SignalK's existing N2K output rather than
  the plugin owning a dedicated, address-claiming CAN device.**
  Researched precedent (`signalk-fusion-stereo`, `RaymarineAPtoFakeNavicoAutoPilot`,
  §13) shows genuine device-identity emulation (correctly answering an
  MFD's ISO Address Claim / Product Information probes as a distinct bus
  node) requires a standalone canboatjs `candevice` with direct CAN
  interface access — a real new hardware/deployment dependency this
  project doesn't currently have and isn't taking on for v1. Chosen
  deliberately over that heavier path to keep the plugin's only
  dependency "SignalK is already configured with _some_ N2K provider,"
  at the accepted cost that whether MFDs still respond usefully to
  broadcasts from a non-self-identified source is genuinely unverified
  (§13) — this is a real risk to the feature working at all, carried
  forward openly rather than hidden behind "full emulation" language
  that would overstate what's actually being built.
- **Spotify credentials as plain config fields** — same trust level as
  every other SignalK plugin setting (stored in SK's config file on
  disk); no separate credential vault. This matches how the rest of the
  SignalK plugin ecosystem handles service credentials, and avoids
  building bespoke secret storage for one backend.
- **Mopidy-TuneIn for internet radio** — no credentials needed, largest
  available station catalog, browsable in Iris out of the box. Chosen
  over a self-maintained curated station list, which would need someone
  to pick and maintain stream URLs for no real benefit over an existing,
  actively-used directory service. **Currently dropped from the image**
  (§13): confirmed by build-testing the same Mopidy-4 incompatibility
  affecting Iris above — TuneIn crashes on the same removed internals.
  Not replaced with a substitute the way Iris was, because Mopidy's
  built-in `stream` extension already plays any http(s) audio URL with no
  extension at all; only TuneIn's searchable station directory is lost,
  not radio playback itself. Re-add if TuneIn (or an alternative) regains
  Mopidy-4 compatibility.
- **Debian trixie over bookworm for the container base image** — Mopidy
  4.x (required by the current, non-deprecated Mopidy-Spotify 5.0.0,
  which needs Mopidy ≥4.0) itself requires Python ≥3.13; bookworm ships
  3.11, trixie ships 3.13. Confirmed by build-testing that
  `apt.mopidy.com` (the previously assumed install path, §6, §12 history)
  is stuck serving Mopidy 3.4.2 on every Debian dist it publishes for, not
  just bookworm — switching apt dists wouldn't have solved it. Mopidy and
  its extensions install from PyPI instead, which resolves cleanly on
  Python 3.13.
- **Snapserver's control API is a raw newline-delimited JSON-RPC-over-TCP
  protocol, not HTTP** — confirmed by build-testing against a real
  Snapserver 0.35.0: the config section conventionally named `[http]`
  does not parse real HTTP requests at all; sending one makes the server
  try to JSON-parse the literal request bytes and fail. This plugin's
  Snapserver client (`src/snapserver-client.ts`) was originally written
  against an assumed real-HTTP `POST /jsonrpc` contract (a reasonable
  assumption from Snapcast's own historical docs and web-client precedent,
  but not what this version's control port actually does) and has been
  rewritten to a raw socket client accordingly, verified end-to-end
  against a real Snapserver with a connected `snapclient`.
- **One canonical state store, all interfaces as peers** — considered and
  rejected: keeping Mopidy as the sole source of truth and having N2K/
  Fusion/REST be one-way mirrors of it (the model this doc originally
  had). That breaks the moment a command needs to _originate_ from an MFD
  or a REST call, which the Fusion-Link requirement makes a first-class
  case, not an edge case. A single canonical store that every adapter
  both reads and writes avoids each pair of interfaces needing its own
  ad hoc sync logic (N2K↔REST, REST↔web, web↔N2K) — everything syncs
  through one place instead of `O(n²)` interface pairs.
- **Last-write-wins over per-field locking/conflict resolution** — a
  volume knob turned on the MFD at the same moment as a REST call is a
  rare, low-stakes collision (worst case: one of the two intended values
  doesn't stick, briefly). Building real conflict resolution (versioning,
  optimistic locking) for that case isn't worth the complexity; every
  write is still confirmed against Mopidy/Snapserver's actual resulting
  state (§3.2), so the state shown is never wrong, only possibly not
  what the "losing" writer asked for.
- **N2K zone numbers are assigned once and persisted, not recomputed
  live** — Fusion-Link's zone numbering has no natural stable identity of
  its own (it's just 0-3); anchoring it to "the order Snapclients were
  first seen" and persisting that is what makes "Zone 1" mean the same
  physical speaker across restarts, matching how a real Fusion install's
  zone numbers are physically wired and don't move around.
- **One virtual Fusion source, not one per Mopidy backend** — Fusion's
  source concept (AM/FM/Aux/Bluetooth) models physically distinct inputs
  to a stereo; Mopidy's backends (local/radio/Spotify) are more like
  "which library am I browsing," a concept Iris already exposes well.
  Mapping backends to Fusion sources would need per-backend Fusion source
  metadata with no clean protocol fit, for a distinction MFD users likely
  don't think in anyway ("play my music," not "switch to the Local
  input"). AirPlay's per-zone source switch (§6.4) doesn't reopen this —
  it's a genuinely distinct input the same way Aux is, but it's scoped to
  one zone at a time rather than the boat-wide "current source" concept
  Fusion's own source model assumes, so it doesn't map onto Fusion's
  source-select cleanly either. **Confirmed via research, not just
  inferred (§13):** Fusion-Link's protocol has no per-zone source concept
  at all — `fusionSetSource`/`fusionTrackName`/etc. are keyed by
  `sourceId` device-wide, never by zone, matching how real Fusion
  multi-zone hardware actually works (one source distributed to zones
  with independent volume, not independent per-zone source selection).
  So this isn't a gap this plugin could close with more engineering — the
  bus protocol genuinely has nothing to map a per-zone source onto.
- **Snapcast's native `airplay` stream type over hand-rolled
  shairport-sync process management** — Snapcast already spawns and
  manages one `shairport-sync` per configured stream, including its mDNS
  advertisement; reimplementing that (process lifecycle, config
  generation, cleanup) would duplicate infrastructure Snapcast already
  has, for no benefit.
- **Per-zone AirPlay receivers over one boat-wide AirPlay input** — a
  single boat-wide AirPlay target can't express "cockpit guest plays
  their music while salon keeps the Mopidy queue going," which is the
  behavior actually requested; Snapcast's per-group stream assignment
  makes per-zone receivers the natural fit rather than a workaround.
- **True per-zone dynamic stream creation, superseding an earlier
  pre-provisioned-pool design.** The pool existed because Snapcast's
  v0.31.0–v0.32.x control API blocked runtime creation of `process`-type
  streams (`airplay` included) as a CVE-2023-36177 fix — real at the
  time, but version-specific, not a permanent Snapcast property.
  Confirmed via research (§13) that v0.33.0+ reopened it via a
  `sandbox_dir` containment check, and that `RemoveStream` cleanly kills
  the subprocess rather than orphaning it. Since this plugin pins its own
  Snapserver version, requiring ≥ 0.33.0 costs nothing — reverting to
  the simpler design (create on connect, remove on disconnect, correct
  name from the start) removed the entire pool/slot-numbering/
  restart-on-new-zone/phantom-idle-slot complexity that design had
  needed as a workaround for a constraint that no longer applies.
- **Duck triggers are plain delta subscriptions, not a cross-plugin API**
  — considered and rejected the alternative (signalk-jukebox exposing a
  "duck me" API that signalk-wyoming/a VHF plugin calls into, or vice
  versa). Watching already-published SignalK state means neither plugin
  needs to know the other exists, ships against, or version-matches
  anything — the exact same "state, not API" pattern the rest of this
  plugin's own interfaces already follow (§3.2, ARCHITECTURE.md §2.1).
  The cost: this plugin can only react to what those plugins choose to
  publish, and both integrations are hostage to those paths never
  changing shape — accepted, since REST/N2K/etc. face the identical
  "someone else's contract" risk already.
- **VHF ducking is a hard pause (via Mopidy), voice ducking is a volume
  dip (via Snapcast client volume)** — different mechanisms for a
  reason: VHF traffic needs to be intelligible without any music
  competing (safety-relevant, §2), while a voice interaction is short
  and the FutureProofHomes precedent (§11) shows a volume dip is enough
  to keep it intelligible without fully silencing the room. Using
  `Client.SetVolume` for the duck (rather than a Snapcast stream-swap,
  the mechanism this doc originally reached for) was possible once
  research confirmed it's fully dynamic — unlike stream creation, no
  restart involved (SPEC.md §13, ARCHITECTURE.md §5).
- **Per-zone voice ducking via a manually-configured, opt-in
  `satelliteZoneMap`, with unmapped satellites falling back to all-zone
  ducking** — no automatic correlation exists between a
  `voice.satellites.<id>` and a jukebox zone id (a satellite named
  `"cockpit"` doesn't mechanically imply a same-named or otherwise
  identifiable Snapclient is the right one), so guessing at one would be
  fragile. A manual map is honest about that limit while still letting
  an operator who cares get precise per-zone behavior; the all-zone
  fallback for anything unmapped means the feature works safely with
  zero configuration, same as before this was sketched — nobody is
  worse off for the option existing. **The map is an array of
  `{ satelliteId, zoneId }` pairs, not a `Record<string, string>`** —
  confirmed by build-testing against the real Admin UI (§13): its
  schema-form library renders every other plain-object config field on
  the page fine, but a bare `additionalProperties` map with no fixed
  `properties` renders nothing at all under its title — no add button, no
  rows, not even cosmetically broken, just entirely absent. An array of
  objects uses that same library's well-supported array-of-objects field
  instead, which does render an editable, add/removable list.
- **VHF auto-resume tracks `pausedByVhf` rather than unconditionally
  calling `play()` after the delay** — without it, a user who manually
  paused music five minutes before a radio call would have their pause
  silently overridden the moment the call ended, which is a much worse
  surprise than the feature's entire point (not interrupting the user
  unexpectedly).
- **Real AirPlay track metadata (via shairport-sync's metadata pipe) over
  a permanent placeholder** — the earlier "no AirPlay equivalent to show"
  framing was simply wrong: `shairport-sync` already parses and emits
  DAAP-tagged title/artist/album from the sending device, we just weren't
  using it. The device-wide Fusion now-playing constraint (confirmed,
  §13) doesn't go away — there's still no way to show two zones' tracks
  at once — but within that constraint, showing the _real_ track of
  whichever N2K-zoned zone is on AirPlay is strictly better than a fake
  string, so the placeholder is now a fallback (metadata not yet
  arrived), not the primary behavior.
- **Lowest-`n2kZone`-wins tie-break for simultaneous multi-zone AirPlay**
  — chosen over "most recent session wins" because it's deterministic
  and doesn't flap: with a recency rule, the single device-wide broadcast
  would jump between two zones' tracks every time either session
  starts/stops, which reads as broken to anyone watching the MFD. A fixed
  zone priority is predictable, even if "always zone 0" isn't perfectly
  fair to zone 1's listener.
- **AirPlay discoverability requires opting into `networkMode: host`
  (`airplay.hostNetworking`, §9), and no non-host-networking alternative
  was found that actually works on real container-runtime deployments.**
  mDNS advertisement and each per-zone receiver's dynamically-chosen
  RTSP/RTP ports don't reach the LAN through this container's default
  bridged networking at all (confirmed by build-testing, §13's build-
  testing entries below). Two alternatives were investigated and both
  ruled out rather than just assumed impractical:
  - **An mDNS reflector run from the plugin's own process** (inside
    signalk-server, which itself already runs with host networking) —
    doesn't work with rootless Podman's `pasta` networking backend,
    confirmed by checking for a host-visible bridge interface
    (`ip link show type bridge`) and finding none: pasta fully
    encapsulates a container's network in its own namespace with no
    shared L2 segment to reflect between, and has no multicast-
    forwarding feature of its own (it's built for unicast NAT). A
    reflector needs simultaneous presence on both networks in one
    process; there is no host-side attachment point to get that from.
  - **macvlan/ipvlan** (a second, LAN-facing network interface
    attached to the jukebox container alongside its normal one, so
    control traffic keeps working while AirPlay/mDNS get real LAN
    presence) — not pursued further: unclear whether
    `signalk-container`/`signalk-container-helper`'s config surface
    (a single `networkMode` string, ARCHITECTURE.md §5) supports
    attaching a container to two networks at once at all, and macvlan
    is well known to be unreliable on WiFi interfaces specifically
    (many drivers/APs reject the additional MAC address it needs) —
    which is exactly the interface an iPhone's AirPlay traffic would
    arrive over.
    Given both alternatives are either broken by this host's networking
    backend or of uncertain/fragile feasibility, the accepted tradeoff is:
    AirPlay requires the operator to explicitly opt into host networking
    (default off) via the config panel's `hostNetworking` toggle, which
    documents the tradeoff (this container then shares the host's full
    network namespace and port space) directly in its warning banner.
- **A "local snapclient" companion container (`local-snapclient.ts`,
  §9) over expecting every zone to be a separate physical device.** Some
  boats have speakers wired directly to the SignalK server's own
  machine, not just to standalone Snapclient hardware elsewhere on the
  boat. Modeled directly on signalk-wyoming's `local-satellite.ts`,
  which solves the identical "run a companion container alongside the
  main one, on this same host" problem for its own local microphone/
  speaker: a second, independent `ManagedContainer` running this
  project's own minimal `ghcr.io/boathacks/signalk-jukebox-snapclient`
  image (its own Dockerfile — `image-snapclient/` — rather than a
  general-purpose third-party Snapclient image, matching this project's
  existing "build the pieces we actually need" approach to the main
  image). Reaches the main jukebox container's published Snapcast
  stream port via `extraHosts: { skhost: "host-gateway" }` — the same
  mechanism `local-satellite.ts` uses — rather than a literal LAN IP or
  a shared network namespace: confirmed by hand that both of those were
  unreliable under this project's actual rootless-Podman (`pasta`) test
  host, while `host-gateway` is a purpose-built Docker/Podman mechanism
  for exactly "let this container reach the host" and isn't subject to
  the same routing quirks. No "auto" ALSA device fallback is offered —
  confirmed by build-testing (§13) that a bare `default` device is
  ambiguous and fails outright on a host with more than one sound card,
  so the operator must supply an explicit device string from their own
  `aplay -L` output. Once connected, this zone is discovered exactly
  like any other Snapclient (SPEC.md §2's read-only zone
  auto-discovery) — no special-cased UI beyond starting/stopping the
  container and picking its sound card.

## 13. Open Questions

- **Container image build-tested for the first time (2026-08-22) — several
  assumptions turned out wrong, now fixed and re-verified.** Previously
  the image and `snapserver-client.ts` were both written without a
  container runtime available to test against; a session with real Docker
  (Podman) access built and ran the actual stack and found:
  - Mopidy 4.x (needed for the non-deprecated Mopidy-Spotify 5.0.0) breaks
    Iris and Mopidy-TuneIn, which still call removed Mopidy-3 internals —
    see §12's Iris/TuneIn/trixie decisions for the resolution (minimal
    built-in web UI, TuneIn dropped, base image switched to trixie).
  - Snapserver's control port doesn't speak real HTTP despite its config
    section being named `[http]` — see §12's Snapserver decision.
    `snapserver-client.ts`'s `Server.GetStatus` handling had two further
    bugs surfaced by this: the response nests groups under
    `result.server.groups` (not `result.groups`), and raw group/client
    JSON uses `stream_id`/`config.volume.{percent,muted}` rather than this
    client's own camelCase field names — both fixed and verified against
    a real Snapserver with a connected `snapclient`.
  - Smaller config bugs also caught and fixed: an apt keyring path
    mismatch that broke Mopidy's own (now-abandoned, see §12) apt repo,
    Mopidy 4.x's path-expansion no longer resolving `$XDG_MUSIC_DIR` in
    the `m3u`/`file` extensions' defaults, a `pkg_resources`/setuptools
    version pin, and a Snapserver port collision between the deprecated
    `[tcp]` control listener and the always-on `tcp-streaming` audio port
    (both defaulting to 1704).
    What's still _not_ verified by this pass: real AirPlay/shairport-sync
    behavior end-to-end (no AirPlay source was exercised), real Spotify
    playback (still blocked on the upstream login5 issue below), and
    anything N2K/Fusion-Link-related (needs real hardware, see below).
- **Plugin build-tested against a real signalk-server for the first time
  (2026-08-22, via a `signalk devpod`) — six more real bugs found and
  fixed, none of them guessable from reading the code alone.**
  - `package.json` was missing the `signalk-node-server-plugin` keyword
    signalk-server's plugin scanner filters on — the plugin was
    completely invisible to the server, not even listed as disabled.
  - `plugin.start()`'s `{ ...SCHEMA_DEFAULTS, ...rawConfig }` merge
    silently dropped whole nested settings groups (`backends.radio`,
    `.spotify`) whenever a saved config didn't happen to repeat every
    group, crashing startup reading `.enabled` off the resulting
    `undefined` — easy to hit via a partial config save, not a
    hypothetical. Fixed with a proper one-level-deep merge
    (`mergeSettings()`, `src/types.ts`).
  - `imageTag`'s `"auto"` default (a settings-level sentinel meaning
    "track latest") was passed straight through to
    `container.start()` as a literal tag with no `resolveTag` mapping —
    `signalk-container-helper`'s own README documents this mapping as
    required for exactly this case; `podman pull ...:auto` 404'd.
  - The readiness probe (`readiness: { path: "/mopidy/rpc" }`) used a
    POST-only JSON-RPC endpoint for a plain-GET health check, which
    always 405'd — the container never registered "ready," and
    `container.start()` never resolved an address. Switched to the
    built-in web UI's static index (`/jukebox/`), which answers GET with 200.
  - The reverse proxy (ARCHITECTURE.md §2.2, added this same session) hung
    indefinitely on every proxied POST (i.e. every Mopidy JSON-RPC call) —
    signalk-server's own body-parsing middleware had already drained the
    request stream before the catch-all proxy saw it, so `http-proxy`
    piped an already-consumed stream while still declaring the original
    `Content-Length`, and Mopidy hung waiting for bytes that would never
    arrive. Fixed with `http-proxy-middleware`'s built-in `fixRequestBody`
    hook, built for exactly this conflict.
  - `voiceDucking.satelliteZoneMap`'s schema (see §12) rendered as
    nothing at all in the real Admin UI.
  - The plugin never appeared in the SignalK webapps list / App Dock:
    that's a _separate_ keyword (`signalk-webapp`) and mechanism (a
    package's `public/` directory served statically at `/<package-name>/`)
    from plugin discovery, and the plugin had neither. Added the keyword
    plus a minimal `public/index.html` that redirects to the plugin's own
    reverse-proxied web UI path — real content still comes from the
    running container, this is just what makes the plugin discoverable
    as a "webapp" in the SignalK sense (ARCHITECTURE.md §7).
- **AirPlay receiver creation build-tested for the first time (2026-08-22)
  — three more real bugs found and fixed, confirmed by actually creating
  one and checking `avahi-browse`.** Previously `airplay/receiver.ts`'s
  URI-building was written against Snapcast's documented usage comment
  alone, without a running Snapserver to test `Stream.AddStream` against.
  - `shairport-sync` hard-requires a working Avahi client to start at
    all — without one it fails immediately and Snapcast's airplay stream
    type retries it in a tight crash loop, spawning zombie processes
    every ~100ms. Neither `dbus-daemon` nor `avahi-daemon` were ever
    started in the image; `entrypoint.sh` now starts both.
  - The `airplay://` URI's path must be shairport-sync's full path
    inside `sandbox_dir` (`/app/sandbox/shairport-sync`), not just
    `/shairport-sync` — the bare filename resolves via a PATH search
    that finds the image's apt-installed `/usr/bin/shairport-sync`
    first and gets rejected by Snapcast's sandbox containment check.
  - `devicename=` (not `name=`) is what becomes shairport-sync's
    `--name=`, the actual AirPlay mDNS-advertised device name —
    `name=` is only the Snapcast stream's own internal id. The
    previous version only set `name=`, which would have left every
    zone's receiver advertised under shairport-sync's own hardcoded
    default ("Snapcast") rather than its intended per-zone name. Also
    removed a nonexistent `metadata_pipename` parameter (confirmed
    against Snapcast's actual source: the metadata pipe path is derived
    internally from pid+port, not settable via the URI).
    After these fixes, a real `airplay://` stream creates successfully and
    `avahi-browse` confirms a correctly-named AirPlay (`AirTunes Remote
Audio`) service is advertised. `port=` is also confirmed real (pins
    the RTSP port; Snapcast auto-increments on a bind conflict, confirmed
    in the source's stderr-handling), which is what keeps each zone's
    AirPlay traffic inside a small, boundable port range rather than a
    fully dynamic one — useful background for §12's host-networking
    decision, though it doesn't change that decision (mDNS itself still
    needs a real LAN-facing network regardless of how bounded the ports
    are).
- **shairport-sync metadata pipe: exact parsing approach not chosen.**
  The pipe emits DAAP-tagged binary chunks (a documented but not
  trivially-JSON format — `shairport-sync`'s own docs and reference
  scripts like `shairport-sync-metadata-reader` describe the tag
  structure); whether to hand-roll a small parser or find/adapt an
  existing Node one is an implementation detail to settle when §6.4 is
  built, not a design question. Doesn't block the design in §4/§6.3/§6.4.
- **wyoming-satellite as a zone type.** Satellites are ALSA
  speaker/mic devices already deployed on some boats for voice, not
  Snapclients. A future zone backend could target a satellite's control
  API for music playback the same way Snapcast targets a Snapclient — but
  this depends on a stable, documented streaming path into
  wyoming-satellite's control API that doesn't exist yet. Deferred until
  that's real (see signalk-wyoming SPEC.md §9, which lists "Snapcast as
  an announce target" as its own stretch goal — the interop may end up
  flowing the other direction instead: signalk-wyoming targeting this
  plugin's Snapserver for announcements, rather than jukebox targeting
  satellites for music).
- **Mopidy-Spotify auth mechanics.** Mopidy-Spotify's actual credential
  requirements (username/password vs. client ID/secret vs. a device-auth
  flow) need to be verified against its current documentation before
  finalizing the config schema in §9 — Spotify's own auth requirements
  for third-party clients have changed over time and librespot-based
  integrations have had stability issues historically.
- **VHF `.busy` is receive-only — confirmed via research, accepted as a
  known gap.** Neither `htool` ICOM plugin publishes anything for your
  own outgoing transmission (PTT) — `communication.vhf.busy` only
  reflects incoming channel activity (squelch opening). So VHF ducking
  only fires for calls you're receiving, not ones you're making;
  covering outgoing PTT would need a feature request against those
  plugins (or a different radio integration entirely) — not something
  fixable from this side. Documented as a real, permanent limitation of
  this integration, not a TODO.
- **Auto-detecting the satellite↔zone correlation, rather than requiring
  manual config.** §6.5/§9's `satelliteZoneMap` is user-configured by
  design (§12) — there's no reliable way to infer it (a satellite id
  like `"cockpit"` doesn't mechanically imply a same-named Snapclient is
  the right one, or exists at all). An auto-detection heuristic would
  need designing jointly with signalk-wyoming, not guessed at
  unilaterally here; not attempted for MVP.
- **Restoring a zone's volume after a voice duck when the user changed
  it mid-duck.** Current design overwrites whatever the user set during
  the duck with the pre-duck value (§6.5, §12) — an accepted
  simplification, not solved. Worth watching for real complaints before
  adding the complexity of tracking "did the user touch this since
  ducking started."
- **Mopidy-Spotify credential shape — researched and corrected, plus a
  real reliability finding.** Confirmed (2026-08-22): `username`/
  `password` config is deprecated as of Mopidy-Spotify v5.0.0 (Spotify
  disabled that login path for third-party clients entirely); the
  correct fields are `client_id`/`client_secret` from a registered app,
  which §9's schema now reflects. Separately, and more materially:
  Mopidy-Spotify currently has an **open, unresolved upstream issue**
  (mopidy-spotify#437, filed 2026-08-11) where Spotify's login5
  authentication rejects valid third-party credentials outright —
  basic playback, not just extras like recommendations. The extension
  itself is actively maintained (commits as recent as this research
  date), so this reads as "temporarily broken by a Spotify-side change,
  maintainers are actively working it," not "abandoned project" — but
  it means the Spotify backend should ship documented as **currently
  unreliable**, not as a solid MVP feature, until upstream resolves it.
  If it isn't resolved by implementation time, standalone `librespot` /
  `go-librespot` (bridged in some form) is the fallback path community
  members in that issue thread report as still working via a Spotify
  Connect handoff — not designed here, just noted as the escape hatch.
- **NMEA2000 address claiming — researched, resolved against a lighter
  approach, but with a real open risk left behind.** Confirmed (by
  reading `signalk-fusion-stereo`'s source, plus the
  `RaymarineAPtoFakeNavicoAutoPilot` precedent) that `app.emit(
'nmea2000out', ...)` transmits under the SignalK server's own already-
  claimed address — it does **not** give the plugin a distinct,
  independently-recognized bus identity. `signalk-fusion-stereo` itself
  never needed one: it's a _controller_ of an existing real Fusion unit,
  not an emulator, so it has zero ISO Address Claim (PGN 60928) /
  Product Information (PGN 126996) code to learn from. Genuine
  emulation needs a standalone, address-claiming canboatjs `candevice`
  with direct CAN interface access (§12) — rejected as out of scope for
  v1 (§1.4). **What remains genuinely unverified:** whether a
  Fusion-Link-aware MFD will accept and act on Fusion PGN broadcasts from
  a source that never answers an ISO/product-info probe as its own
  device. This can only really be settled by testing against real
  hardware (a Garmin MFD or similar) — treat §6.3 as unproven until that
  happens, and be ready for the answer to be "it doesn't work well
  enough," which would force revisiting the CAN-ownership tradeoff (§12)
  later.
- **Fusion-Link protocol accuracy and drift risk.** Because Fusion has
  never published the protocol, the implementation is only as correct as
  whatever community reverse-engineering exists at build time, and
  Fusion/Garmin could change on-the-wire behavior in a firmware update
  with no advance notice. This is an accepted, ongoing risk of building
  against an unofficial protocol, not something resolvable at spec time —
  worth a prominent README caveat once built, mirroring how
  signalk-wyoming calls out its own unverified-hardware status.
- **Real-world coverage of the standard NMEA2000 Entertainment PGN set.**
  Unlike Fusion-Link, it's unverified how many actual chartplotters
  implement the generic Entertainment PGNs at all — if the answer turns
  out to be "effectively none," that part of §6.3 may not be worth
  maintaining relative to Fusion-Link. Revisit once there's a real device
  to test against.
