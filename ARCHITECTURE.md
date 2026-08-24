# signalk-jukebox Architecture

## 1. Overview

signalk-jukebox is a SignalK Node.js plugin that manages one containerized
image (Mopidy + Snapserver) via `signalk-container-helper`'s
`ManagedContainer`, reverse-proxies Mopidy's JSON-RPC endpoint for the
plugin's own authenticated `public/` webapp (playback/zone control, no
library browse/search), and separately publishes Mopidy's own web client
for library browse/search/playlists (intended to be Iris; currently
Mopidy-MusicBox-Webclient, reached directly on the LAN rather than
proxied — SPEC.md §7/§12), and exposes zone volume/mute, image updates,
and NMEA2000/Fusion-Link connectivity through a SignalK Admin config
panel.

The plugin's own process is not just a container manager — it hosts a
**canonical state store** (§2.1) that every interface (Mopidy adapter,
N2K/Fusion adapter, REST, SK paths) reads and writes through, so a
command from any one of them is visible everywhere else (SPEC.md §3.2).

```
                    ┌─────────────────────────────────────────┐
                    │     canonical state store (§2.1)          │
                    │   playback · zones · N2K zone mapping     │
                    └───▲────────▲────────▲────────▲───────────┘
                        │        │        │        │
             ┌──────────┘  ┌─────┘   ┌────┘   ┌────┘
             │ read/write  │ r/w     │ r/w    │ r/w
     ┌───────▼──────┐ ┌────▼─────┐ ┌─▼──────┐ ┌▼────────────┐
     │ Mopidy/       │ │ N2K/     │ │ REST   │ │ SK paths     │
     │ Snapserver    │ │ Fusion   │ │ API    │ │ (PUT-able)   │
     │ adapter       │ │ adapter  │ │        │ │              │
     └───────┬───────┘ └────┬─────┘ └────────┘ └──────────────┘
             │              │ app.emit('nmea2000out', ...)
             │              │ + PGN-in hook (SignalK's N2K provider)
             │              ▼
             │        ┌───────────┐
             │        │ N2K bus   │──▶ Fusion-Link-aware MFD (Garmin, …)
             │        └───────────┘
             ▼
┌─────────────────────── SignalK server host ──────────────────────┐
│  ┌──────────────────────────────────────────┐                    │
│  │ signalk-jukebox container                  │                    │
│  │  ┌────────────┐   ┌────────────┐          │                    │
│  │  │  Mopidy    │──▶│ Snapserver │◀─────────┼── raw TCP JSON-RPC  │
│  │  │(+webclient)│   │            │          │   (zone volume/mute)│
│  │  └─────┬──────┘   └─────┬──────┘          │                    │
│  │        │ read-only      │ :1704/:1705       │                    │
│  │  ┌─────▼──────┐         │                  │                    │
│  │  │  library    │        │                  │                    │
│  │  │  bind mount │        │                  │                    │
│  │  └────────────┘         │                  │                    │
│  └──────────────────────────┼──────────────────┘                    │
│         managed via signalk-container                               │
└──────────────────────────────┼───────────────────────────────────────┘
                                │ Snapcast stream :1704
                     ┌──────────▼──────────────────────────┐
                     │   boat LAN                            │
                     │  Snapclient: Cockpit  (n2kZone 0)      │◀── own AirPlay receiver "Jukebox - Cockpit"
                     │  Snapclient: Salon    (n2kZone 1)      │◀── own AirPlay receiver "Jukebox - Salon"
                     │  Snapclient: Cabin    (no N2K slot)    │◀── own AirPlay receiver "Jukebox - Cabin"
                     └──────────────────────────────────────┘
```

Each zone gets its own Snapcast `airplay`-type stream (each managing its
own `shairport-sync` instance + mDNS advertisement), **created the
moment the zone connects and removed the moment it disconnects** — no
pool, no cap, no persisted slot. Confirmed via research (§5, SPEC.md
§13): Snapserver ≥ 0.33.0's control API can both create and cleanly
remove `process`-type streams (which `airplay` is) at runtime, via a
`stream.sandbox_dir` containment check rather than an outright block —
an earlier design believed this was permanently closed and built a
pre-provisioned-pool workaround around that belief; it wasn't, and the
workaround is gone. Each zone's Snapclient keeps a single Snapcast group
for its whole lifetime; switching between the shared Jukebox (Mopidy)
stream and that zone's own AirPlay receiver is `Group.SetStream` on that
one group — fully dynamic, no restart (SPEC.md §2, §6.4).

Snapclients are external — deployed and managed independently, out of
this plugin's scope (SPEC.md §1.4). The N2K bus connection is likewise
external to the container: it goes through the SignalK server process
itself, via whatever N2K provider/gateway is already configured
(ARCHITECTURE.md §5) — the container never touches N2K at all.

## 2. System Components

### 2.1 Canonical state store

The single in-process object (an event-emitting store, not a database —
see §4) holding `PlaybackState`, the `Zone` list, and `ZoneAssignment`
(SPEC.md §4). It is the only writable copy; every adapter below reads it
to render its own outward representation and writes to it (never to each
other directly) when a command arrives on its interface.

- **Write path:** an adapter receives a command (e.g. N2K volume-set,
  REST `POST`, Mopidy JSON-RPC event) → applies it to the real backend
  (Mopidy or Snapserver) if the command isn't already a confirmation from
  one → the backend's actual resulting state is written into the store →
  the store emits a change event.
- **Read path:** every adapter subscribes to store change events and
  updates its own outward channel (delta publish, outgoing PGN broadcast,
  SSE/poll response) — adapters never poll each other, only the store and
  their own backend (Mopidy/Snapserver).
- **Conflict handling:** last-write-wins per field (SPEC.md §12); no
  versioning/locking. Because writes are confirmed against Mopidy/
  Snapserver's actual resulting state rather than applied optimistically,
  the store never holds a value neither backend actually has.
- **Persistence:** the store's `ZoneAssignment` map and the queue
  snapshot (§2.2) are the two pieces written to the data volume; the rest
  of the store is rebuilt from Mopidy/Snapserver on each start.

### 2.2 Mopidy/Snapserver adapter

- Owns the container lifecycle end to end via `ManagedContainer`
  (`start()`, `stop()`, update routes) — follows the exact pattern in
  signalk-container-helper's README "Quick start: a managed container".
- Reverse-proxies HTTP requests to Mopidy's JSON-RPC endpoint (`/mopidy/
  rpc`) at a plugin-owned path, so the browser never needs to know the
  container's internal port — used by the plugin's own `public/` webapp.
  Mopidy's own web client (currently Mopidy-MusicBox-Webclient, Iris once
  compatible — SPEC.md §7, §12) is NOT reverse-proxied: its UI runs
  entirely over a WebSocket (`/mopidy/ws`), and forwarding a WS upgrade
  needs the raw `http.Server`, which SignalK's plugin API doesn't expose
  to `registerWithRouter`. It's published directly to the LAN instead
  (`container.ts`'s `ports`, `MOPIDY_PORT` bound to `0.0.0.0`) and the
  config panel links straight at that address — bypassing SignalK's own
  auth for that one connection, an accepted trade-off (§12).
- Snapweb (Snapserver's own official web client, SPEC.md §7, §12) is
  published the same way, for the same WS-proxying reason, at its own
  `SNAPWEB_PORT` (1780) — deliberately NOT the same port as
  `SNAPCAST_CONTROL_PORT` (1705), even though both are served by
  Snapserver: confirmed by build-testing that putting Snapweb's `[http]`
  section on the same port as the control API's `[tcp-control]` breaks
  HTTP parsing for the shared port entirely (§12).
- The plugin's own `public/app.js` webapp connects directly to both
  `MOPIDY_PORT`'s `/mopidy/ws` and `SNAPWEB_PORT`'s `/jsonrpc` for live
  playback/zone updates, the same direct-port bypass as the two bullets
  above (for the same reason: `proxy.ts` can't forward either WebSocket
  upgrade). Confirmed live: Mopidy pushes each core event as flat JSON
  with an `"event"` key (not a JSON-RPC notification); Snapserver pushes
  event-specific notifications (`Group.OnMute`, `Client.OnVolumeChanged`,
  etc.), not a uniform full-state broadcast, so the webapp just
  re-requests `Server.GetStatus` on any notification and re-renders from
  that rather than hand-applying each shape. Mutations (play/pause/
  volume, zone source/volume/mute) still go through the proxied Mopidy
  RPC endpoint and `/api/zones` REST route respectively — only the
  read/live-update path bypasses the proxy.
- A second Snapcast stream, `"Alerts"` (`ALERTS_STREAM_ID`, container.ts),
  is a standing announcement intake (Snapcast's `tcp server` source type,
  `ALERTS_PORT` 4953) any other container/process can connect to and
  stream a WAV-framed announcement into. A zone can be manually switched
  onto it (`src/routes.ts`'s `/source` endpoint, alongside `"jukebox"`) —
  added specifically so taking a zone off the jukebox stream doesn't
  require muting its Snapclient outright, which would also silence
  announcements meant for it (SPEC.md §12). `zone-sync.ts` derives
  `activeSource` as `"alerts"` when a group's `stream_id` resolves to
  this stream, same mechanism as the existing `"jukebox"`/`"airplay"`
  cases. Published to the LAN the same way as `SNAPWEB_PORT`/`MOPIDY_PORT`
  above (container.ts's `ports`) — not routed through this plugin's own
  REST API at all, so any producer just needs a plain TCP connection.
- A third stream, `"MusicAndAlerts"`
  (`meta:///Alerts/MopidyOnly?name=MusicAndAlerts`, snapserver.conf.template),
  auto-ducks: Snapcast's `meta` source type plays whichever listed source
  is currently active, Alerts taking priority over MopidyOnly (Mopidy's
  own raw audio, renamed from `"Jukebox"` in the same change as this
  stream), confirmed by build-testing to switch to Alerts the instant it
  goes active and fall back to MopidyOnly the instant it goes idle again —
  no muting or `Group.SetStream` calls needed from any plugin.
  `"MusicAndAlerts"`, not the raw `"MopidyOnly"` stream, is what
  `JUKEBOX_STREAM_ID` (`zone-sync.ts`, `routes.ts`) actually means now —
  the raw stream is a meta-stream input only, never a zone's own direct
  assignment. `migrateZonesToCurrentJukeboxStream()` (`zone-sync.ts`,
  `LEGACY_JUKEBOX_STREAM_IDS`) runs once at plugin start: any zone still
  on `"Jukebox"` or this stream's own earlier name `"Output"` is moved
  onto `"MusicAndAlerts"`, so upgrading needs no manual per-zone re-click.
  Those legacy names could only ever be found because Snapcast's own
  assignment state wasn't actually persisted at the time -- `dataMount`
  below fixes that going forward.
- A fourth stream, `"Silence"` (`pipe:///tmp/silencefifo?name=Silence`,
  snapserver.conf.template), for a zone that should hear nothing at all,
  not even announcements. `entrypoint.sh` starts `cat /dev/zero >
  /tmp/silencefifo &` before Snapserver — all-zero bytes are digital
  silence in S16LE PCM, and the FIFO's own kernel buffer naturally paces
  the writer to Snapserver's actual read rate, so no audio tooling or
  sample-rate awareness is needed on the writer side. `routes.ts`'s
  `/source` endpoint accepts `"silence"` as a third value alongside
  `"jukebox"`/`"alerts"`; the webapp's per-zone control is three exclusive
  buttons, not a two-way toggle.
- `dataMount` (`container.ts`'s `CreateManagedContainerArgs`) mounts this
  plugin's own persistent data dir at `/data`, resolved the same way
  `libraryMount` already was (`resolveMount()` against
  `app.getDataDirPath()`, not `ContainerConfig.signalkDataMount` — that
  resolves to *signalk-container's* own data dir, per its own doc
  comment) but unconditionally, not gated on the local-library backend.
  Mopidy's own `data_dir`/`cache_dir` (mopidy.conf.template) and
  Snapserver's `[server] datadir` (snapserver.conf.template, pointed at
  `/data/snapserver`) both live under it now — confirmed the hard way
  that neither survived a real container recreate before this, only a
  plain restart of the same container.
- **Resolves its own address differently under `airplay.hostNetworking`
  (SPEC.md §12).** The normal path (`signalkAccessiblePorts` +
  `readiness`) can't be used there at all: confirmed against a real
  production instance that signalk-container discards `networkMode:
"host"` outright the moment `signalkAccessiblePorts` is also set,
  silently reverting to bridge mode — which meant this container ran in
  bridge mode even with host networking supposedly on, while `ports`
  was _also_ omitted (since the code assumed host networking was really
  applying), leaving Snapcast completely unpublished either way. Fixed
  by omitting both `signalkAccessiblePorts` and `readiness` under host
  networking (the latter depends on the former for address resolution,
  and a real host-networking container publishes no parseable ports at
  all for the fallback path either) and substituting a hardcoded
  `HOST_NETWORKING_ADDRESS` (`container.ts`) instead: sharing the
  host's network namespace makes Mopidy's port simply _be_ the host's
  own port, nothing left to resolve.
- Polls Mopidy's JSON-RPC API (`playback-sync.ts`, same pattern
  `zone-sync.ts` uses for Snapserver) for playback state/track/volume/
  mute, writing every change into the canonical store (§2.1) --
  confirmed by a real user report that without this, the store's
  playback state never left its "stopped" startup default no matter
  what was actually playing, since nothing else ever wrote to it.
  Mopidy's own WS event-stream endpoint (`/mopidy/ws`) would push
  changes instead of polling for them, but isn't proxied or connected
  to yet (`mopidy-client.ts`, `proxy.ts`'s own doc comment) -- polling
  every 2s is the interim substitute. Applies canonical-store writes
  that originated elsewhere (N2K, REST) to Mopidy via the same
  JSON-RPC API.
- Periodically snapshots the tracklist/position for restart persistence
  (SPEC.md §8), and restores it into Mopidy on the next container start
  before the store is considered "ready." (Not yet implemented --
  tracked as a TODO in `mopidy-client.ts`.)
- Polls Snapserver's JSON-RPC control API for connected clients and
  their volume/mute, writing zone state into the canonical store;
  applies zone volume/mute writes that originated elsewhere to Snapserver
  the same way.
- **Creates and removes each zone's AirPlay receiver** (SPEC.md §6.4;
  `src/airplay/receiver.ts`) — confirmed via research (SPEC.md §13) that
  Snapserver ≥ 0.33.0 supports this at runtime via `Stream.AddStream`/
  `RemoveStream`, superseding an earlier pre-provisioned-pool design. On
  zone connect: `Stream.AddStream` with an `airplay://` URI carrying the
  zone's real name from the start (no placeholder-then-rename step). On
  zone disconnect: `Stream.RemoveStream` — confirmed to cleanly kill the
  `shairport-sync` process group, not orphan it. Neither the new stream
  nor its removal touches the zone's group directly — creating a
  receiver doesn't switch the zone onto it (§2's "connecting is the
  switch" rule); that's `src/airplay/zone-binding.ts`'s job, described
  next.
- **Switches each zone between its Jukebox and AirPlay streams**
  (`src/airplay/zone-binding.ts`): each zone's Snapclient keeps one
  Snapcast group for its whole lifetime; watching for that group's
  stream-status changes (an AirPlay session starting/ending, detected
  via Snapserver reporting the stream's status — SPEC.md §3.2) drives a
  `Group.SetStream` call pointing the zone's _existing_ group at either
  the shared Jukebox stream or that zone's own AirPlay stream — never a
  client reassignment between groups, and no group is ever created or
  deleted (there is no such RPC, SPEC.md §13). Writes the resulting
  `activeSource` into canonical state (§2.1).
- **Tails each zone's `shairport-sync` metadata pipe** (SPEC.md §6.4;
  `src/airplay/metadata.ts`) and writes parsed title/artist/album into
  that zone's `Zone.airplay.track` (§2.1) as it arrives — feeds both the
  zone-level SK path and, for N2K-zoned zones, the N2K/Fusion adapter's
  broadcast (§2.3, SPEC.md §6.3).
- Serves the Admin config panel (via `signalk-container-helper/ui`
  building blocks) for backend toggles, library path, Spotify
  credentials, zone controls, N2K/Fusion settings, AirPlay toggle, and
  image updates.

### 2.3 NMEA2000 / Fusion-Link adapter

- **Does not claim a distinct NMEA2000 source address** — researched and
  deliberately scoped out (SPEC.md §1.4, §12, §13): genuine device-
  identity emulation (correctly answering an MFD's ISO Address Claim /
  Product Information probes as a distinct bus node) requires a
  standalone, address-claiming canboatjs `candevice` with direct CAN
  interface access, following the precedent of
  `RaymarineAPtoFakeNavicoAutoPilot` (a standalone process against the
  CAN interface, not embedded plugin logic). This adapter instead
  broadcasts under the SignalK server's own already-claimed address,
  same as the precedent studied for this decision,
  [signalk-fusion-stereo](https://github.com/sbender9/signalk-fusion-stereo)
  (itself a _controller_ of a real Fusion unit, not an emulator, and
  confirmed via source reading to have no address-claiming code either).
  Whether MFDs respond usefully to broadcasts from a non-self-identified
  source is unverified against real hardware — SPEC.md §13 carries this
  forward as an open risk, not a resolved detail.
- **Implemented** (`n2k/fusion.ts`, `n2k/apply-command.ts`, `n2k/zone-mapping.ts`,
  `state/zone-assignments-file.ts`; wired into `index.ts`) against
  `@canboat/ts-pgns` v1.11.18's real, shipped PGN classes — Fusion-Link
  only; the generic/standard Entertainment PGN secondary surface
  (`n2k/entertainment-pgn.ts`) is still an intentional stub, deferred
  until there's a real device to confirm it's worth maintaining (SPEC.md
  §13). Confirmed by typecheck + a real unit test suite (not real
  hardware — SPEC.md §13's bus-identity risk remains genuinely
  unverified).
- **Outbound:** on every canonical-store change event, `FusionAdapter.
  broadcastState()` constructs the relevant `@canboat/ts-pgns` PGN 130820
  status objects and sends each via `app.emit('nmea2000JsonOut',
  pgnInstance)` — confirmed against `sbender9/signalk-fusion-stereo`'s
  own real source (not the flat-string `app.emit('nmea2000out',
  pgnString)` convention this doc originally assumed) that a modern
  SignalK server (`app.config.version` ≥ 2.15.0) accepts the constructed
  PGN object directly, no Actisense-string encoding step needed. Also
  re-broadcasts current state on a periodic interval
  (`FUSION_REFRESH_INTERVAL_MS`, `fusion.ts`) and immediately on a
  decoded `requestStatus` command, so a device joining the bus
  mid-session gets current state without waiting for the next actual
  change (SPEC.md §6.3). **Now-playing source selection** (device-wide
  field, SPEC.md §6.3, §12): Mopidy's track, unless an N2K-zoned zone's
  `activeSource` is `airplay`, in which case that zone's `Zone.airplay.
  track` if present (else the "AirPlay Active" placeholder) — and if
  more than one N2K-zoned zone is on AirPlay simultaneously, the lowest
  `n2kZone` number's track wins.
- **Inbound:** `app.on('N2KAnalyzerOut', ...)` receives every PGN on the
  bus, already decoded into a `@canboat/ts-pgns`-shaped object (no raw
  byte parsing needed) — `FusionAdapter.decodeIncoming()` matches it
  against the known PGN 126720 Fusion command sub-messages via each
  class's own static `isMatch()`, and `apply-command.ts`'s
  `applyFusionCommand()` dispatches the result through the *exact* same
  methods the REST/webapp write paths already use (`MopidyClient.play()/
  pause()/next()/previous()/setMute()`, `SnapserverClient.
  setClientVolume()` + `store.setZone()`) — an MFD is not a
  second-class caller (SPEC.md §6.3). `FusionSetSource`/`FusionSetPower`
  decode to no actionable command (single-virtual-source model, no
  "power" concept of this plugin's own).
- **Zone mapping:** `n2k/zone-mapping.ts`'s `claimN2kZone()`, called from
  `zone-sync.ts`'s own tick the first time a Snapclient id is ever seen
  (not gated behind `n2k.enabled` — SPEC.md §2's own "the first zone a
  Snapclient is ever seen at is assigned" applies regardless, so a zone
  already has a stable number if N2K gets enabled later), reads/writes
  `ZoneAssignment` (§2.1) to translate between Snapclient ids (used
  everywhere else) and the small integer zone numbers (0–3,
  `N2K_ZONE_CAP`) Fusion-Link actually carries. Persisted via
  `state/zone-assignments-file.ts` (atomic write-then-rename JSON,
  `app.getDataDirPath()`) — loaded once at `index.ts` startup, before
  zone-sync's first tick runs, and saved again every time a zone claims
  a genuinely new slot.
- Entirely optional — when `n2k.enabled` is `false` (SPEC.md §9), the
  Fusion adapter itself does not run (no broadcast, no incoming-command
  handling); every other component is unaffected (the store and its
  other adapters have no dependency on N2K being present). Zone-number
  claiming/persistence above happens regardless of this toggle.

### 2.4 Container image (`signalk-jukebox` image, built by this repo)

Build-tested end to end (2026-08-22, via Podman) — the design below
reflects what's actually confirmed working, not just what was drafted;
see SPEC.md §13 for the full list of what that testing pass caught and
fixed.

- Base is Debian **trixie**, not bookworm: Mopidy 4.x — required by the
  non-deprecated Mopidy-Spotify 5.0.0 (Mopidy-Spotify's 4.1.1, the version
  pip resolves against an older Mopidy, depends on the discontinued
  libspotify/pyspotify stack) — itself requires Python ≥3.13, which
  bookworm doesn't ship. Mopidy and its extensions install from PyPI, not
  `apt.mopidy.com` (confirmed stuck serving Mopidy 3.4.2 on every dist it
  publishes for).
- Mopidy + Mopidy-Local + Mopidy-Spotify installed; each backend
  individually enabled/disabled by config the plugin writes into Mopidy's
  config file before/at container start. **No Mopidy-TuneIn**: confirmed
  incompatible with Mopidy 4.x (calls internals it removed); Mopidy's
  built-in `stream` extension still plays direct http(s) URIs without it
  (SPEC.md §5, §12).
- **No Mopidy-Iris.** Confirmed incompatible with Mopidy 4.x (tracked
  upstream as [jaedb/Iris#999](https://github.com/jaedb/Iris/issues/999),
  unresolved) — its `mopidy_iris/core.py` imports `mopidy.models.serialize`,
  a Mopidy-3-era internal Mopidy 4 removed. In its place,
  Mopidy-MusicBox-Webclient: confirmed by build-testing (and a GitHub code
  search of its whole repo) that it does NOT touch that internal or
  `mopidy.internal` anywhere, so it loads cleanly against Mopidy 4 — it
  registers via the same `http:app` mechanism Iris itself uses, at
  `/musicbox_webclient/`. It needs one separate, unrelated fix: its
  `__init__.py` does `import pkg_resources` for its own version string,
  and setuptools≥80 (current PyPI) dropped `pkg_resources` entirely, so
  `image/Dockerfile` pins `setuptools<80` ahead of installing it (confirmed
  working at 79.0.1). Its whole UI runs over Mopidy's WebSocket
  (`/mopidy/ws`) with no HTTP fallback anywhere in its JS — unlike the
  polling-based UI it replaced, so it can't go through this plugin's own
  reverse proxy (proxy.ts has no access to the raw `http.Server` needed to
  forward a WS upgrade). It's published straight to the LAN instead
  (`container.ts`'s `ports`, §2.2), an accepted trade-off: Mopidy has no
  auth of its own regardless, but this is now reachable from anywhere on
  the LAN, not just this host. Swap back to Iris once it's
  Mopidy-4-compatible (SPEC.md §7, §12) — nothing else in this
  architecture depends on which one is mounted.
- Snapserver, configured to receive Mopidy's audio output as its source
  and expose the Snapcast stream + control API. **The control API is raw
  newline-delimited JSON-RPC over TCP, not HTTP**, confirmed by
  build-testing — the config section conventionally named `[http]` does
  not parse real HTTP requests; `src/snapserver-client.ts` was rewritten
  from an HTTP-`fetch`-based client to a raw socket client accordingly
  (§5).
- The one piece built from scratch for this project — no existing image
  bundles Mopidy+Snapcast+a web frontend together the way this needs.
  Follows the precedent of signalk-wyoming's purpose-built
  `wyoming-satellite` image for the same "glue upstream processes
  together" reason.

### 2.5 Duck-trigger adapter

- Subscribes to two external, optional SignalK delta paths —
  `communication.vhf.busy` (confirmed real, published by the `htool`
  ICOM VHF plugins) and `voice.satellites.<id>.state` (signalk-wyoming)
  — via SignalK's normal `app.streambundle`/subscription mechanism, the
  same way any plugin consumes another plugin's deltas. Neither plugin
  is a listed dependency; a missing path is a normal, silent no-op
  (SPEC.md §2, §5).
- On VHF busy/clear, calls `MopidyClient.pause()`/`play()` directly
  (SPEC.md §6.5) and tracks `DuckState.pausedByVhf` so the auto-resume
  never overrides a manual pause.
- On voice satellite state transitions, resolves that satellite's target
  zones via `voiceDucking.satelliteZoneMap` (mapped zone, or every known
  zone if unmapped — SPEC.md §6.5, §9) and calls
  `SnapserverClient.setClientVolume()` per target zone — this is the
  same fully-dynamic RPC call the REST volume route uses
  (ARCHITECTURE.md §5), not a new capability. Tracks
  `DuckState.activeDucksBySatellite` so a zone targeted by two
  overlapping satellite sessions isn't restored until both end.
- `DuckState` (SPEC.md §4) is held in-memory only, not part of the
  canonical `CanonicalState`/`StateStore` (§2.1) and not persisted (§8)
  — it's internal bookkeeping for this adapter's own restore logic, not
  state any other interface needs to read.

### 2.6 External: Snapclients

Not part of this repo. Any Snapcast-compatible client on the boat LAN
that connects to this container's Snapserver becomes a zone automatically
(SPEC.md §2 — read-only discovery, no manual provisioning).

### 2.7 Playback-control adapter (`src/controls.ts`)

- Subscribes to four `entertainment.jukebox.playback.controls.*` paths
  (SPEC.md §6.2) via `app.streambundle`, the same subscription mechanism
  §2.5's duck-trigger adapter uses — but the reverse role: this is the
  _consumer_ of momentary pushbutton input (an NMEA2000 switch via
  another plugin, a webapp button, anything that can publish a delta),
  not a publisher of canonical state.
- Edge-detects each path's own last-seen value and calls the matching
  `MopidyClient` method (`play`/`pause`/`next`/`previous`) only on a
  `0/false -> 1/true` transition; release and any repeated `1` without an
  intervening release are no-ops, so a source that periodically republishes
  its current value can't double-fire an action.
- Started/stopped alongside the main container in `index.ts` (constructs
  its own `MopidyClient` against the container's resolved address once
  `start()` completes, same pattern as `SnapserverClient`/`zone-sync.ts`);
  unsubscribes on plugin `stop()`.
- Registers meta (no value) for all four paths synchronously in
  `start()`, independent of the container (`registerControlsMeta`) —
  confirmed by a real user report that a subscribed-but-never-published
  path is otherwise invisible in SignalK's own data model (no value, no
  meta) until some external source sends the first real delta, making
  these impossible to find in the Data Browser on a system with nothing
  wired up to press them yet.

### 2.8 PUT-handler adapter (`src/put-handlers.ts`)

- Implements the "PUT-able" paths §6.2's table already documented
  (`playback.volume`, `zones.<id>.volume`, `zones.<id>.muted`) via
  `app.registerPutHandler` — a PUT is just another way to reach the same
  canonical-state write path routes.ts's REST routes use, calling the
  same `MopidyClient.setVolume`/`SnapserverClient.setClientVolume` and
  writing the confirmed result into the store, not applied optimistically.
- `playback.volume` is registered once, synchronously, in `start()` — it
  doesn't need a container instance to exist yet, only a `MopidyClient` to
  call once one does, so the handler itself holds a mutable
  `MopidyClientState` box (same pattern as `proxy.ts`'s `MopidyProxyState`)
  and 503s "container not ready yet" until `start()`'s `startSafely` block
  fills it in.
- `zones.<id>.volume`/`.muted` can't be registered up front the same way:
  `registerPutHandler` takes one exact literal path per call, and zone ids
  aren't known until Snapserver reports them. Instead, this adapter
  subscribes to the canonical store's own "zone" change event (the same
  event `paths.ts` publishes from) and registers both paths for a zone id
  the first time it's seen, tracked in-memory so the 2s zone-sync poll —
  which calls `setZone` every tick regardless of whether anything actually
  changed — doesn't attempt the same registration repeatedly. There is no
  `unregisterPutHandler` in the SignalK plugin API, so a zone that
  disappears just leaves an inert, harmless handler behind for its old id.

## 3. Data Models

See SPEC.md §4 for the conceptual shapes (`PlaybackState`, `Zone`,
`QueueSnapshot`, `ZoneAssignment`, `PluginSettings`). Concrete TypeScript
types live in `src/types.ts` once implementation starts; this doc is not
the source of truth for field-level detail, SPEC.md §4 is.

## 4. Technology Stack

| Layer                  | Choice                                                                                                                                               | Why                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin runtime         | Node.js / TypeScript                                                                                                                                 | Matches signalk-container-helper's requirement (Node ≥ 22, ESM) and the rest of the SignalK plugin ecosystem                                                                                                                        |
| Container helper       | `signalk-container-helper` (`ManagedContainer`)                                                                                                      | Purpose-built for exactly this lifecycle; avoids re-deriving polling/readiness/update-route code every containerized plugin has hand-rolled                                                                                         |
| Music server           | Mopidy                                                                                                                                               | Extensible backend model (local/radio/Spotify from one server), mature, actively maintained                                                                                                                                         |
| Web client             | Iris (intended); Mopidy-MusicBox-Webclient currently, LAN-direct not proxied                                                                             | Iris avoids building a competing player UI (SPEC.md §12), but is confirmed incompatible with the Mopidy 4.x this project requires (jaedb/Iris#999, unresolved) — swap back once that's fixed upstream                               |
| Multi-zone audio       | Snapcast (Snapserver in-container, Snapclients external)                                                                                             | Purpose-built for synced multi-zone playback with independent per-zone volume; existing Snapclient images/hardware boaters can deploy independently                                                                                 |
| AirPlay receiving      | Snapcast's built-in `airplay` stream source type (wraps `shairport-sync` per stream)                                                                 | Reuses Snapcast's own process/mDNS lifecycle management per stream instead of the plugin hand-rolling multiple `shairport-sync` instances (SPEC.md §12)                                                                             |
| Canonical state store  | In-process `EventEmitter`-backed object, no external DB                                                                                              | State is small (playback + a handful of zones), lives entirely for the plugin's own runtime, and needs sub-second propagation to adapters — a database would add latency and an operational dependency for no benefit at this scale |
| NMEA2000 / Fusion-Link | Encode/decode against SignalK's own N2K provider (`app.emit('nmea2000out', ...)` + PGN-in hook); PGN definitions sourced from Canboat where possible | Rides the boat's existing N2K gateway instead of requiring dedicated CAN hardware/access for this plugin (SPEC.md §1.4, §13)                                                                                                        |
| Admin config panel     | React via `signalk-container-helper/ui`                                                                                                              | Reuses the shared status-card/version-dropdown/update-controls vocabulary rather than hand-copying it (per that library's stated purpose)                                                                                           |

## 5. Integration Points

- **signalk-container** — the container runtime manager, reached via
  `globalThis.__signalk_containerManager` per `signalk-container-helper`
  conventions. Never imported directly (runtime-only coupling).
- **signalk-container-helper** — `ManagedContainer`, `resolveMount`,
  `startSafely`, `registerUpdateRoutes`, and the `/ui` component library.
  Version-pinned per that library's type-contract compatibility notes.
- **Mopidy JSON-RPC/HTTP API** (in-container, `:6680` by default) — the
  Mopidy adapter's channel for playback state sync and queue
  snapshot/restore. Contract: Mopidy's documented core API
  (`core.playback.*`, `core.tracklist.*`).
- **Snapserver JSON-RPC control API** (in-container) — zone discovery,
  volume/mute control, and per-zone AirPlay stream create/remove/switch
  (SPEC.md §6.4). **Confirmed via research (SPEC.md §13), in two passes:**
  (1) `Stream.AddStream`/`RemoveStream` can create/remove `process`-type
  streams (`airplay` included) as of Snapserver v0.33.0+ (PR #1444,
  "Sandbox") — the v0.31.0 restriction that motivated an earlier
  pre-provisioned-pool design was a real, but version-specific,
  CVE-2023-36177 mitigation, since loosened in favor of a `stream.
sandbox_dir` executable-path containment check. This project pins its
  own Snapserver version (§2.4), so requiring ≥ 0.33.0 costs nothing.
  (2) `RemoveStream` was independently confirmed to SIGINT the whole
  process group (killing `shairport-sync` and its children, not
  orphaning them) and to leave any group still pointed at the removed
  stream merely unassigned (silent), not errored — the one caveat is an
  open Snapcast bug (#1455) where a stream URI's `controlscript=`
  parameter specifically leaks on removal; this plugin doesn't use that
  parameter (§6.4), so it doesn't apply. There is no `Group.Create`/
  `Delete` RPC — `Group.SetStream` (pointing an existing group at a
  different stream) is what switches a zone between Jukebox and AirPlay,
  never a group creation. Contract: Snapcast's documented JSON-RPC
  protocol (`doc/json_rpc_api/control.md` in the Snapcast repo, now at
  `snapcast/snapcast` — moved from `badaix/snapcast`). **Wire protocol
  confirmed by build-testing against a real Snapserver 0.35.0:** despite
  the config section conventionally named `[http]`, the control port does
  not parse real HTTP requests at all — it's a raw, newline-delimited
  JSON-RPC-over-TCP protocol (the same one the `tcp-control` section
  speaks). `src/snapserver-client.ts` originally assumed real HTTP (a
  `fetch`-based `POST /jsonrpc` client, matching Snapcast's own historical
  web-client-facing docs) and has been rewritten to a raw socket client,
  verified end-to-end (`getGroups`, `setClientVolume`, `setGroupStream`)
  against a real Snapserver with a connected `snapclient`.
- **SignalK's NMEA2000 provider** — outbound via `app.emit('nmea2000out',
pgnString)`, inbound via SignalK's PGN-in event hook. The plugin does
  not talk to a CAN interface directly; whatever gateway (Actisense,
  Yacht Devices, canable/socketcan) is already configured for the SK
  server carries these messages (SPEC.md §1.4, ARCHITECTURE.md §2.3).
  Address-claiming mechanics for the emulated Fusion device are
  unverified against this integration point as of this writing (SPEC.md
  §13) — first implementation task for §2.3, not an assumption to build
  on top of yet.
- **Fusion-Link protocol** — unofficial/reverse-engineered (SPEC.md §13);
  PGN encode/decode implemented against community documentation, cross-
  referenced with Canboat's PGN database where it overlaps. `@canboat/
ts-pgns` (the structured PGN library `signalk-fusion-stereo` uses for
  its Fusion PGN 126720 message construction) is a candidate dependency
  worth evaluating during implementation rather than hand-rolling PGN
  encode/decode from scratch.
- **`communication.vhf.busy`** (ARCHITECTURE.md §2.5) — an external,
  optional delta from the `htool` ICOM VHF plugins, not a SignalK-spec-
  standard path (confirmed via reading those plugins' source, SPEC.md
  §13). Receive-side only; no outgoing-PTT equivalent exists to consume.
- **`voice.satellites.<id>.state`** (ARCHITECTURE.md §2.5) — an
  external, optional delta from signalk-wyoming. This plugin has no
  dependency on signalk-wyoming's package existing; it only reads
  whatever delta happens to be on that path, exactly as it would from
  any other plugin publishing it.
- **SignalK server** — standard plugin lifecycle (`start`/`stop`/
  `registerWithRouter`/`schema`), `app.setPluginStatus`/`setPluginError`,
  delta publishing for `entertainment.jukebox.*` paths, and PUT handling
  for the PUT-able zone paths (SPEC.md §6.2).

## 6. Security Considerations

- **REST routes respect SignalK access control** — read access for
  status/zone GETs, write access for volume/mute mutations, admin for
  update-apply and (implicitly, via the plugin config panel) Spotify
  credential entry — same model as signalk-wyoming and other
  container-helper plugins.
- **Spotify credentials stored at the same trust level as other plugin
  config** — SignalK's config file on disk, no separate secret store
  (SPEC.md §9, §12). Anyone with filesystem or admin-panel access to the
  SignalK install can read them; this matches the trust boundary of every
  other SignalK plugin credential today, not a new exposure.
- **The web client/Mopidy reverse-proxied, not directly exposed** — the
  plugin fronts it so it rides the same network exposure as the rest of
  the SignalK Admin UI rather than opening a separate port.
- **Snapcast stream/control ports are unauthenticated**, same caveat
  signalk-wyoming documents for Wyoming satellite ports — anyone on the
  boat LAN who can reach the Snapserver port can listen to or control
  playback. Worth a documented callout in the README (mirroring
  signalk-wyoming's "treat every port like a baby monitor" framing),
  network isolation (VLAN/firewall) is the boat operator's
  responsibility, not something this plugin can enforce.
- **NMEA2000 has no authentication at all** — any device on the N2K bus
  can send Fusion-Link commands the plugin will accept and apply, exactly
  as it would accept a command from a legitimate MFD (§2.3). This is the
  ambient trust model of NMEA2000 generally (any bus device can send any
  PGN), not a gap specific to this plugin — but it does mean the N2K/
  Fusion-Link interface has **no** access-control layer analogous to
  SignalK's own read/write/admin permissions on REST and SK-path writes
  (§6.1, §6.2). Document this plainly; it's a property of the bus, not
  something implementable away here.
- **Canonical state store has no auth boundary of its own** — every
  adapter (Mopidy, N2K/Fusion, REST, SK paths) is trusted equally; access
  control happens at each adapter's own edge (SignalK permissions for
  REST/SK paths, physical bus access for N2K), not inside the store.
- **Library mount is read-only** at the container level — Mopidy has no
  write path into the user's music folder even if compromised.
- **AirPlay receivers are unauthenticated by default**, same as a stock
  `shairport-sync`/home AirPlay speaker — anyone on the boat LAN who can
  see the mDNS advertisement can connect and play audio to that zone
  while it's not otherwise in use. `shairport-sync` supports PIN-based
  pairing; whether to enable it (trading zero-friction guest use for some
  protection) is a config-time tradeoff to expose, not decided here.
  mDNS names (`{boatName} - {zoneName}`, SPEC.md §9) are broadcast in
  clear on the LAN — a mild information disclosure (boat name, zone
  layout) worth a one-line README note, not a blocking concern.
- **AirPlay requires opting into `networkMode: host` (`airplay.
hostNetworking`, SPEC.md §9, §12) — a real, larger exposure than the
  point above, not just "unauthenticated on the LAN."** Host networking
  removes this container's network namespace isolation entirely: every
  port it opens binds directly on the host's real interfaces, sharing
  the host's full port space with every other process on the machine
  (the SignalK server itself included), and the container can reach
  anything the host's own network stack can reach with no NAT boundary
  in between. This is confirmed to be the only working option given
  this project's actual constraints (SPEC.md §12 documents the mDNS-
  reflector and macvlan alternatives investigated and ruled out) — not
  a default, and not silently applied: the config panel's toggle is off
  by default and its warning banner states the tradeoff plainly before
  an operator opts in.
- **Dependency audit: no install script runs on a real deployment.**
  Checked `package-lock.json` for every dependency (direct and
  transitive) carrying a `hasInstallScript` flag (npm's own marker for a
  package with a `preinstall`/`install`/`postinstall` script) — the only
  hit is `fsevents` (a `devDependency`, pulled in transitively via
  webpack's file-watching chain), and it is `optional: true` restricted
  to `"os": ["darwin"]`. This plugin's actual target is a SignalK server
  on Linux (Raspberry Pi or similar), where npm skips `fsevents`
  entirely on the OS mismatch — so in practice zero install scripts run
  for a real install of this plugin. No other dependency has one.
- **Snapserver's `stream.sandbox_dir` containment check (SPEC.md §13)
  exists specifically because unrestricted process-stream creation was a
  real, exploited-class vulnerability (CVE-2023-36177, arbitrary command
  execution) — it replaced, rather than removed, that protection.** This
  plugin's `airplay://` stream URIs (§2.2, `src/airplay/receiver.ts`)
  must only ever reference the `shairport-sync` executable the image
  places inside the configured sandbox directory (`image/Dockerfile`) —
  never a user-influenced or dynamically-constructed path. The zone
  name embedded in each stream's `name=` parameter is free text (from
  Snapclient-reported hostnames or SK config) and must be treated as
  such when building the URI — not filesystem-path input, but still
  worth sanitizing/escaping properly rather than string-concatenating it
  in.

## 7. File Structure

Indicative layout, following signalk-container-helper's own repo shape
where useful:

```
signalk-jukebox/
├── AGENTS.md / CLAUDE.md      # contributor guidance (once written)
├── SPEC.md                    # this pair — the what/why
├── ARCHITECTURE.md            # the how (this file)
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # plugin entry (start/stop/schema/router)
│   ├── container.ts           # ManagedContainer setup, buildConfig()
│   ├── state/
│   │   └── store.ts           # canonical state store (§2.1) — the shared source of truth
│   ├── mopidy-client.ts       # JSON-RPC client: playback state, tracklist snapshot/restore
│   ├── snapserver-client.ts   # JSON-RPC client: zone list, volume/mute
│   ├── proxy.ts                # reverse-proxies the plugin's router path to the running container (§2.2)
│   ├── zone-sync.ts            # polls Snapserver, keeps the canonical store's zones in sync (§2.2)
│   ├── playback-sync.ts        # polls Mopidy, keeps the canonical store's playback state in sync (§2.2)
│   ├── local-snapclient.ts     # optional 2nd ManagedContainer: a Snapclient zone on this host's own sound card (§12)
│   ├── n2k/
│   │   ├── fusion.ts          # Fusion-Link encode/decode + address claiming
│   │   ├── entertainment-pgn.ts # standard NMEA2000 Entertainment PGN encode/decode
│   │   └── zone-mapping.ts    # Snapclient id <-> n2kZone persistence (§2.1)
│   ├── airplay/
│   │   ├── receiver.ts         # per-zone Stream.AddStream/RemoveStream create+remove (§2.2, §6.4)
│   │   ├── zone-binding.ts     # Group.SetStream switch between Jukebox/AirPlay, same group throughout (§2.2, §6.4)
│   │   └── metadata.ts         # tails each zone's shairport-sync metadata pipe, parses DAAP tags into Zone.airplay.track (§2.2, SPEC.md §6.4)
│   ├── duck-triggers/
│   │   ├── vhf.ts              # communication.vhf.busy -> Mopidy pause/resume (§2.5, SPEC.md §6.5)
│   │   └── voice.ts            # voice.satellites.*.state -> zone volume duck/restore (§2.5, SPEC.md §6.5)
│   ├── routes.ts              # /api/* Express routes
│   ├── openapi.ts              # OpenAPI 3.0.3 doc for the REST API, exposed via plugin.getOpenApi (SPEC.md §6.1)
│   ├── ghcr-versions.ts       # GHCR tags/list -> VersionInfo[], backs GET /api/versions (SPEC.md §6.1)
│   ├── paths.ts                # entertainment.* SK path publishing + meta (description/units/example, 0-100 -> 0-1 ratio conversion, SPEC.md §6.2)
│   ├── controls.ts             # entertainment.jukebox.playback.controls.* -> Mopidy play/pause/next/previous (§2.7, SPEC.md §6.2)
│   ├── put-handlers.ts         # PUT handling for playback.volume / zones.<id>.volume/muted (§2.8, SPEC.md §6.2)
│   ├── configpanel/            # React admin panel (signalk-container-helper/ui)
│   └── types.ts
├── image/                     # the custom Mopidy+Snapserver+webclient container image (build-tested, §2.4)
│   ├── Dockerfile              # pip-installs Mopidy-MusicBox-Webclient (setuptools<80 pinned), substituting for Iris (§2.2, §2.4)
│   ├── mopidy.conf.template
│   ├── snapserver.conf.template
│   └── entrypoint.sh
├── image-snapclient/           # this project's own minimal Snapclient-only image (SPEC.md §9, §12)
│   ├── Dockerfile
│   └── entrypoint.sh
├── public/                    # signalk-webapp keyword's static mount, served directly at /signalk-jukebox
│   ├── index.html             # the plugin's own authenticated playback/zone UI (transport, volume, per-zone mute/play-here, play-URI, links to Mopidy's own web client + Snapweb) -- no library browse/search itself (§7)
│   └── app.js
├── test/
└── webpack.config.cjs         # config-panel remote build (ESM, per container-helper's UI notes)
```

## 8. Deployment

- Installed as a SignalK plugin (App Store or `npm install`), requiring
  **signalk-container** with a working docker/podman runtime — same
  prerequisite chain as any `ManagedContainer`-based plugin.
- The `signalk-jukebox` container image (and `signalk-jukebox-snapclient`,
  the standalone local-Snapclient image) is published separately at
  `ghcr.io/boathacks/<name>`, and pulled by signalk-container the same way
  any managed image is. `.github/workflows/publish.yml`'s `build-images`
  job rebuilds and pushes both, tagged `:latest` and the exact npm package
  version (e.g. `:0.1.0`), on every GitHub release — so an image is never
  left stale behind a release. `container.ts`/`local-snapclient.ts`'s
  `resolveTag` always maps the plugin's own `"auto"` image-tag setting to
  `:latest`; the version tags exist for pulling a specific historical
  build deliberately, not for anything the plugin resolves to itself.
- Runtime data (Mopidy config/cache, Spotify auth cache, queue snapshot)
  lives in the plugin's `signalkDataMount` volume — survives container
  recreation, per `ManagedContainer` conventions.
- The music library is a host path the operator provides (USB drive,
  pre-mounted NAS share, etc.), bind-mounted read-only via `resolveMount`
  — the operator is responsible for getting that path populated and
  mounted on the host before enabling the local backend (SPEC.md §5, §9).
- Snapclients are deployed and configured entirely outside this plugin's
  install — the README documents how to point one at this container's
  Snapserver address, but doesn't automate it.
- The N2K/Fusion-Link interface requires the boat to already have a
  working NMEA2000 gateway configured in SignalK (§5) — this plugin adds
  no new hardware requirement of its own beyond that, and the interface
  is fully optional (`n2k.enabled: false` by default, SPEC.md §9).

## 9. Future Considerations

- **wyoming-satellite as a second zone backend type — investigated and
  shelved, not just deferred.** The idea was a `ZoneBackend` seam
  (Snapcast vs. satellite-control-API) analogous to signalk-wyoming's
  `Satellite` interface, so the zone list/volume API in §5/SPEC.md §6.1
  wouldn't need to change shape, only gain a second implementation behind
  it. Checked in practice (2026-08-24): `wyoming-satellite` (the project
  signalk-wyoming targets) is no longer maintained — its own README says
  it's been replaced by
  [Linux Voice Assistant](https://github.com/OHF-Voice/linux-voice-assistant),
  which uses Home Assistant's ESPHome protocol instead of Wyoming.
  Tellingly, Linux Voice Assistant's own docs list "media player" as a
  *new* capability over wyoming-satellite (a `--music-output-device` flag
  backed by `mpv`, exposed as a proper Home Assistant `media_player`
  entity) — confirming Wyoming's own `wyoming.snd` primitive (piping
  `AudioChunk` events into a `--snd-command` like `aplay`) was only ever
  built for short voice-interaction audio (wake/done/timer sounds, TTS
  replies), not sustained music playback; that's a real protocol gap, not
  an unbuilt feature. A satellite-as-zone would mean adopting ESPHome +
  Home Assistant's media-player model instead, an entirely different
  integration surface than this project's existing SignalK/Snapcast one —
  not worth pursuing unless/until signalk-wyoming itself moves off
  wyoming-satellite onto Linux Voice Assistant/ESPHome.
- **Voice announcement ducking** — if signalk-wyoming's stretch goal
  ("Snapcast as an announce target") is picked up, the natural seam is
  signalk-wyoming's orchestrator becoming a second Snapserver _source_
  (or ducking this plugin's stream) rather than this plugin knowing
  anything about voice — keeps the two plugins' responsibilities
  separate.
- **Direct NAS/SMB support** — Mopidy has an SMB extension; adding it
  would remove the "operator must pre-mount the share on the host"
  requirement in §8, at the cost of the container needing SMB
  credentials/network access it doesn't have today.
- **Manual zone naming/grouping** — MVP's read-only auto-discovered zone
  list (SPEC.md §2) could grow persisted zone metadata (custom names,
  saved groupings) if the auto-discovered hostname-based naming proves
  insufficient in practice.
- **Multiple N2K/Fusion virtual sources** — if MFD users do turn out to
  want per-backend source switching (SPEC.md §12's rejected alternative),
  the `n2kZone`-style persisted-assignment pattern used for zones could
  extend to a persisted backend→source-number mapping without disturbing
  the canonical-state shape.
- **Standard Entertainment PGN coverage becomes moot** — if real-world
  testing (SPEC.md §13) shows no chartplotters actually implement the
  generic PGN set, `src/n2k/entertainment-pgn.ts` could be dropped
  entirely in favor of Fusion-Link only, without affecting any other
  component (it sits behind the same adapter boundary as Fusion-Link,
  §2.3).
- **Android-equivalent casting** (SPEC.md §1.4, §10.2) — Chromecast,
  Bluetooth A2DP, or DLNA/UPnP would each need their own adapter
  alongside `src/airplay/`; whichever is chosen should confirm its own
  stream type is covered by the same Snapserver `sandbox_dir` mechanism
  AirPlay relies on (§5) — if it needs a _different_ Snapcast stream type
  than `process`/`pipe`/etc., that's a fresh compatibility question, not
  something to assume solved by AirPlay's precedent.
- **A real address-claiming Fusion device, if best-effort proves
  insufficient** (SPEC.md §12, §13) — if testing against real MFD
  hardware shows the current approach doesn't work well enough, the
  fallback is a standalone canboatjs `candevice` process with direct CAN
  access (the `RaymarineAPtoFakeNavicoAutoPilot` pattern), wired into
  SignalK as a piped provider rather than embedded in this plugin's own
  process — a meaningfully bigger scope change, not a tweak, so worth
  treating as a distinct future decision rather than pre-building for it.
- **AirPlay PIN pairing** (§6 above) — currently open by default; could
  become a per-zone or boat-wide config toggle if unauthenticated
  receivers prove to be a real problem in practice rather than a
  theoretical one.
- **Auto-detecting the `satelliteZoneMap` correlation** (SPEC.md §13) —
  MVP's mapping is manual/opt-in; an auto-detection heuristic would need
  designing jointly with signalk-wyoming, not attempted unilaterally.
- **A standalone librespot/go-librespot fallback for Spotify** (SPEC.md
  §12, §13) — if Mopidy-Spotify's current upstream login5 breakage
  (mopidy-spotify#437) isn't resolved by implementation time, community
  reports in that issue thread suggest a Spotify-Connect-handoff-based
  librespot setup still works; not designed here, just the noted escape
  hatch if the backend as speced turns out unshippable.
- **Outgoing VHF (PTT) ducking** (SPEC.md §13) — not possible today; the
  `htool` ICOM plugins don't publish anything for it. Would need a
  feature request against those plugins (or a different radio
  integration) before this plugin could react to it — not something to
  build speculatively here.
