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
[Snapcast](https://github.com/badaix/snapcast), with synchronized playback
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

The primary human control surfaces are Mopidy's own web client
([Iris](https://github.com/jaedb/Iris)), reverse-proxied through the
SignalK server, and any Fusion-Link-compatible MFD already on the boat.
The plugin's own SignalK Admin config panel handles container lifecycle,
image updates, N2K/Fusion configuration, and zone volume/mute — it is not
a player.

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
- **AirPlay slot** — one of a fixed pool of `N` (configurable,
  `airplay.maxZones`, §9) statically-configured Snapcast `airplay`-type
  streams, provisioned at container start. A zone claims a slot the
  first time it's ever seen (persisted assignment, like `n2kZone`, §2,
  §4), and is bound/unbound from it dynamically on every connect/
  disconnect thereafter — see §6.4 for why streams are pooled rather
  than created per zone on demand.
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
- **Every zone gets its own AirPlay receiver, drawn from a fixed pool of
  pre-provisioned slots (§6.4).** Snapcast's control API cannot create
  `airplay`-type streams at runtime (deliberately blocked as a security
  fix, §13) — so `N` (configurable, §9) AirPlay streams are statically
  configured at container start, and a zone claims one slot the first
  time it's ever seen, persisted thereafter (like `n2kZone`, §4). Binding
  and unbinding a zone's Snapclient to its claimed slot on every connect/
  disconnect is fully dynamic (no restart); only a **brand-new** zone
  (never seen before) triggers a one-time config regeneration + restart
  so its slot's `shairport-sync` advertises the zone's real name. This is
  per-zone, not boat-wide — someone can AirPlay to the cockpit
  specifically while the salon keeps playing the Mopidy queue. A zone
  beyond the pool size (`airplay.maxZones`, §9) gets no AirPlay slot,
  same as a zone beyond the N2K zone cap gets no `n2kZone`.
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
  interface is enabled, broadcast it — see §13 for whether that should
  even happen given the "one virtual Fusion source" decision in §12). A
  zone without a claimed slot (beyond the pool size, §9) has no AirPlay
  path at all and stays on `jukebox`.

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
- **Zone** — `{ id, name, connected: boolean, volume: number (0-100), muted: boolean, n2kZone?: number, activeSource: 'jukebox'|'airplay', airplay?: { streamName, connected: boolean } }`
  — `id` is the Snapclient's Snapcast-assigned id; `name` is whatever the
  Snapclient reports (typically its hostname) unless overridden. `n2kZone`
  (0–3) is present only for zones assigned an N2K/Fusion slot (§2, §8);
  absent for zones beyond the protocol's zone count. `airplay.streamName`
  is the mDNS name that zone's receiver advertises (e.g. "Jukebox -
  Cockpit", §9); `airplay.connected` reflects whether a device currently
  has an active AirPlay session to it.
- **QueueSnapshot** (plugin-managed persistence, see §8) — the serialized
  Mopidy tracklist + current track index + position, snapshotted
  periodically and on clean `stop()`, restored on the next container
  start.
- **ZoneAssignment** (plugin-managed persistence, see §8) — the persisted
  Snapclient-id → `{ n2kZone?: number, airplaySlot?: number }` mapping
  (§2), independent of whether that Snapclient is currently connected.
  Both numbers are assigned once, the first time a Snapclient is seen,
  and never reassigned automatically thereafter.
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
- **Internet radio** — a Mopidy radio-station extension (e.g.
  Mopidy-TuneIn or a curated station list); requires internet
  connectivity to resolve streams, gracefully unavailable when offline
  (boats lose connectivity — this must not be treated as an error state).
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

Actual playback control (play/pause/skip/queue/search) goes through Iris
directly against Mopidy's own HTTP/JSON-RPC API — this plugin does not
proxy or re-implement it.

### 6.2 SignalK Paths / Events

Under `vessels.self`, a custom `entertainment.*` branch (outside the
SignalK schema, following the same convention signalk-wyoming uses for
`voice.*`). Like every other interface, these paths are a **view onto
canonical state** (§4) — PUTs to them apply to canonical state (and from
there to Mopidy/Snapserver) exactly like a REST call or a Fusion-Link
command would; deltas are published on every canonical-state change
regardless of which interface caused it:

| Path                                         | Value                            | Notes                             |
| -------------------------------------------- | -------------------------------- | --------------------------------- |
| `entertainment.jukebox.playback.state`       | `'stopped'\|'playing'\|'paused'` |                                   |
| `entertainment.jukebox.playback.track`       | `{ name, artist?, album? }`      | Present only while playing/paused |
| `entertainment.jukebox.playback.volume`      | `number` (0-100), PUT-able       | Master volume (§4)                |
| `entertainment.jukebox.zones.<id>.connected` | `boolean`                        |                                   |
| `entertainment.jukebox.zones.<id>.volume`    | `number` (0-100), PUT-able       |                                   |
| `entertainment.jukebox.zones.<id>.muted`     | `boolean`, PUT-able              |                                   |
| `entertainment.jukebox.zones.<id>.n2kZone`   | `number` (0-3), read-only        | Present only if assigned (§2)     |

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
doc). Track/now-playing metadata is Mopidy-specific and has no AirPlay
equivalent to show — rather than broadcast stale or wrong Mopidy track
data while a zone is actually playing someone's AirPlay session, **if
any N2K-zoned zone's `activeSource` is `airplay`, the broadcast
now-playing field is replaced with a fixed placeholder ("AirPlay
Active") instead of real track info** (§12). This doesn't say _which_
zone — **confirmed via research, not assumed (§13): Fusion-Link's
now-playing/source fields (`fusionSetSource`, `fusionTrackName`,
`fusionArtistName`, `fusionAlbumName`) are all keyed by `sourceId`, never
by zone — there is no `fusionSetZoneSource` or per-zone track message
anywhere in the protocol, matching real Fusion hardware's own
architecture (one source distributed to zones with independent
volume/EQ, not independent per-zone source selection)** — but the
placeholder still avoids showing information that's flatly false.

**Bus-identity caveat (confirmed via research, §13):** the plugin
broadcasts Fusion PGNs under the SignalK server's own already-claimed
N2K address rather than claiming a distinct address for itself as a
proper "Fusion device" (§1.4 non-goals) — a deliberate scope decision,
not an oversight. Whether Fusion-Link-aware MFDs still usefully accept
and act on these broadcasts without the plugin passing an ISO Address
Claim / Product Information challenge as its own device is **unverified
and a real risk to the whole feature**, not a cosmetic gap — see §13.

### 6.4 AirPlay Zone Receivers

**Confirmed via research (§13): Snapcast's control API cannot create
`airplay`-type streams at runtime** — this was deliberately removed as
part of a security fix (CVE-2023-36177, arbitrary command execution via
the stream-add RPC) and only non-process stream types were reinstated.
So MVP uses a **pre-provisioned pool**, not per-zone dynamic stream
creation, managed entirely by the Mopidy/Snapserver adapter
(ARCHITECTURE.md §2.2) — no separate REST surface; this is
infrastructure, not something a user configures per-zone beyond the
boat-wide toggle and pool size in §9.

- **Pool provisioning:** at container start, `airplay.maxZones` (§9)
  Snapcast `airplay`-type streams are statically configured, each
  spawning its own `shairport-sync` instance. Slots for zones not yet
  claimed use a placeholder name (e.g. "Jukebox AirPlay (unassigned)").
- **Slot claim (first time a zone is ever seen):** the plugin assigns
  the next free slot to that Snapclient id, persists the assignment
  (`ZoneAssignment.airplaySlot`, §4, §8), regenerates Snapserver's config
  with that slot's `shairport-sync` renamed per §9's naming pattern, and
  restarts Snapserver once to apply it — a brief, boat-wide audio
  interruption, accepted as the cost of a real per-zone name (chosen over
  the generic-numbered-slots alternative, §12). This happens **once per
  zone, ever** — not on every connect.
- **Bind/unbind (every connect/disconnect thereafter):** the zone's
  Snapclient is attached to or detached from its already-claimed,
  already-named slot's group via `Group.SetClients`/`Group.SetStream` —
  fully dynamic, no restart, no config change.
- **No teardown on disconnect:** unlike the original per-zone-dynamic
  design, a claimed slot's `shairport-sync` keeps running (and
  advertising via mDNS) even while its zone is disconnected — Snapcast's
  RPC restriction (above) means the plugin can't remove the stream
  without the same restart cost as creating one, so it's left running
  idle instead. A phantom AirPlay target for a currently-offline zone is
  a minor, accepted UX blemish (§12), not a functional problem — audio
  sent to it simply has no Snapclient to reach.
- **Pool exhaustion:** a zone beyond `airplay.maxZones` claims no slot
  and has no AirPlay path (§2); the Admin panel should surface this
  plainly rather than fail silently.
- **Naming collisions:** if two zones would produce the same advertised
  name (e.g. duplicate zone names), the plugin must disambiguate (e.g.
  append the Snapclient id) rather than silently advertise two identical
  AirPlay targets — exact scheme TBD at implementation time.

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

- A satellite's **target zones** = `voiceDucking.satelliteZoneMap[satelliteId]`
  if present, else every known zone (the unmapped fallback).
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

- **Iris** (Mopidy's web client) — reverse-proxied at
  `/signalk-jukebox` (or similar), the primary and only playback control
  surface. Standard Iris UI: search, browse library, queue, playlists.
  No SignalK-specific modifications to Iris itself in MVP.
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

| Setting                                       | Default                         | Notes                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libraryPath`                                 | — (required for local playback) | Host folder bind-mounted read-only via `resolveMount()`                                                                                                                                  |
| `backends.local.enabled`                      | `true`                          |                                                                                                                                                                                          |
| `backends.radio.enabled`                      | `false`                         | Internet radio via Mopidy-TuneIn (§12); requires internet connectivity, no credentials needed                                                                                            |
| `backends.spotify.enabled`                    | `false`                         | See the reliability caveat in §5 before enabling — currently degraded upstream                                                                                                           |
| `backends.spotify.clientId` / `.clientSecret` | —                               | Corrected via research (§13) — Mopidy-Spotify v5.0.0+ requires a registered app's OAuth client credentials, not username/password, which Spotify disabled for third-party login entirely |
| `imageTag`                                    | `auto`                          | Standard container-helper update-tracking convention                                                                                                                                     |
| `n2k.enabled`                                 | `false`                         | Master toggle for the N2K/Fusion-Link interface                                                                                                                                          |
| `n2k.deviceName`                              | `"Jukebox"`                     | Presented as the Fusion device's name on the bus                                                                                                                                         |
| `n2k.deviceInstance`                          | `0`                             | NMEA2000 device instance, in case a boat somehow runs two jukebox-like devices                                                                                                           |
| `airplay.enabled`                             | `true`                          | Master toggle for per-zone AirPlay receivers (§6.4)                                                                                                                                      |
| `airplay.maxZones`                            | `4`                             | Size of the pre-provisioned AirPlay stream pool (§6.4); zones beyond this get no AirPlay slot                                                                                            |
| `airplay.namePattern`                         | `"{boatName} - {zoneName}"`     | mDNS name template for a slot once claimed by a zone; `{boatName}` sourced from SignalK's own vessel name where available                                                                |
| `vhf.enabled`                                 | `true`                          | Master toggle for the VHF pause trigger (§6.5); harmless if no VHF plugin is installed — the path just never fires                                                                       |
| `vhf.resumeDelaySeconds`                      | `5`                             | Delay after `communication.vhf.busy` clears before auto-resuming                                                                                                                         |
| `voiceDucking.enabled`                        | `true`                          | Master toggle for the voice-activity duck trigger (§6.5)                                                                                                                                 |
| `voiceDucking.duckVolumePercent`              | `20`                            | Zone volume (0-100) while any voice satellite is active                                                                                                                                  |
| `voiceDucking.resumeDelaySeconds`             | `1`                             | Delay after a satellite returns to `idle` before restoring its target zones' volume                                                                                                      |
| `voiceDucking.satelliteZoneMap`               | `{}`                            | Optional `voice.satellites.<id>` → jukebox zone id map (§2, §6.5); satellites with no entry duck all zones (safe fallback)                                                               |

## 10. MVP Scope

### 10.1 MVP Features

- Containerized Mopidy (local files backend) + Snapserver in one image,
  managed via `ManagedContainer`.
- Local library via read-only bind mount (`resolveMount`).
- Internet radio and Spotify backends, both optional/toggleable from the
  Admin panel.
- Iris reverse-proxied as the control surface.
- Multi-zone audio via Snapcast; zones auto-discovered (read-only list +
  volume/mute) in the Admin panel.
- Plugin-managed queue/position snapshot + restore across restarts.
- A canonical shared-state store (§3, §4, ARCHITECTURE.md §2) that Iris/
  Mopidy, REST, SK paths, and N2K/Fusion all read and write through.
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
- [Snapcast](https://github.com/badaix/snapcast)
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
  Iris doesn't do.
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
  actively-used directory service.
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
- **Pre-provisioned AirPlay pool + one-time restart-per-new-zone, over
  either (a) fully dynamic per-zone stream creation or (b) permanent
  generic slot names.** (a) turned out not to be possible — Snapcast
  blocks runtime creation of `process`-type streams (`airplay` included)
  as a deliberate CVE-2023-36177 fix, not an oversight (§13). Between the
  two real remaining options, a one-time restart when a genuinely new
  zone first appears (rare — happens once per physical zone added to the
  boat, ever) was chosen over permanently generic "AirPlay 1..N" slot
  names, because the whole point of naming receivers per zone ("Jukebox -
  Cockpit") was for someone to find the right one without being told
  which number maps to which speaker — that benefit is worth one brief
  boat-wide audio bounce per zone's lifetime, paid once.
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
  worse off for the option existing.
- **VHF auto-resume tracks `pausedByVhf` rather than unconditionally
  calling `play()` after the delay** — without it, a user who manually
  paused music five minutes before a radio call would have their pause
  silently overridden the moment the call ended, which is a much worse
  surprise than the feature's entire point (not interrupting the user
  unexpectedly).
- **A fixed "AirPlay Active" placeholder over surfacing per-zone AirPlay
  state to Fusion-Link properly** — not a workaround pending a better
  idea, but the only option: Fusion's now-playing concept is confirmed
  (not assumed, §13) to be one value for the whole device, so there is no
  protocol-level way to say "zone 2 is on AirPlay, zone 1 isn't," full
  stop, on any implementation. A placeholder is strictly better than
  leaving stale/wrong Mopidy track data displayed, at near-zero
  implementation cost, so it's in MVP rather
  than deferred — unlike the harder, genuinely-unresolved problems (a
  per-zone Fusion source model doesn't exist to build against) that stay
  open.
- **Leaving a disconnected zone's AirPlay slot running rather than
  tearing it down** — the alternative (restart to remove it, then
  restart again if the zone reconnects) would mean _every_ zone
  connect/disconnect costs a restart, defeating the entire point of the
  pool/bind-unbind split above. A harmless idle `shairport-sync` instance
  is a better trade than that.

## 13. Open Questions

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
  the duck with the pre-duck value (§6.5, §12) — same category of
  "known simplification, not solved" as the AirPlay pool's phantom-slot
  behavior. Worth watching for real complaints before adding the
  complexity of tracking "did the user touch this since ducking
  started."
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
- **Whether Snapserver supports live stream/group provisioning —
  researched and resolved: partially.** Confirmed against Snapcast's
  current control API docs and source history (current stable: v0.35.0):
  `Stream.AddStream`/`RemoveStream` exist, but are restricted by an
  explicit type whitelist (`pipe`, `file`, `tcp`, `alsa`, `jack`, `meta`)
  — `process`-type streams (which `airplay` is, internally) were
  deliberately excluded when the RPC was reinstated in v0.31.0 after
  being pulled entirely in v0.30.0 to fix CVE-2023-36177 (arbitrary
  command execution via the stream-add RPC). There is also no
  `Group.Create`/`Delete` RPC at all — groups only exist implicitly via
  client-to-stream assignment. What **is** fully dynamic: reassigning an
  existing client between existing groups/streams
  (`Group.SetClients`/`SetStream`), which is what §6.4's pool-based
  design relies on. §6.4 has been revised accordingly (pre-provisioned
  pool + one-time restart per brand-new zone, not per-connect). One loose
  end: whether a v0.33.0 changelog line suggesting process-stream RPC
  support might have loosened this since v0.31.0 is unconfirmed and
  contradicts the current docs/PR discussion — worth a direct source
  check (`server/streamreader/stream_manager.cpp` in the actual
  Snapcast version this project pins) before relying on the restriction
  being unchanged.
