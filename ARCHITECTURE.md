# signalk-jukebox Architecture

## 1. Overview

signalk-jukebox is a SignalK Node.js plugin that manages one containerized
image (Mopidy + Snapserver) via `signalk-container-helper`'s
`ManagedContainer`, reverse-proxies Mopidy's web client (Iris) for
playback control, and exposes zone volume/mute, image updates, and
NMEA2000/Fusion-Link connectivity through a SignalK Admin config panel.

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
│  │  │  Mopidy    │──▶│ Snapserver │◀─────────┼── JSON-RPC control  │
│  │  │ (+ Iris)   │   │            │          │   (zone volume/mute)│
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
                     │  Snapclient: Cockpit  (n2kZone 0)      │◀── bound to AirPlay slot 1 "Jukebox - Cockpit"
                     │  Snapclient: Salon    (n2kZone 1)      │◀── bound to AirPlay slot 2 "Jukebox - Salon"
                     │  Snapclient: Cabin    (no N2K slot)    │◀── unbound (pool slot 3/4 free or unclaimed)
                     └──────────────────────────────────────┘
```

AirPlay receivers are a **fixed pool** of `airplay.maxZones` (SPEC.md §9)
statically-configured Snapcast `airplay`-type streams (each managing its
own `shairport-sync` instance + mDNS advertisement), provisioned once at
container start — **not** created per zone on demand. Snapcast's control
API cannot add `process`-type streams (which `airplay` is) at runtime, by
deliberate design (a CVE fix — ARCHITECTURE.md §5, SPEC.md §13). A zone
permanently claims one pool slot the first time it's ever seen (persisted,
like `n2kZone`); a zone's Snapclient group is dynamically bound to
either the shared Jukebox (Mopidy) stream or its claimed AirPlay slot at
any given moment via `Group.SetClients`/`SetStream` — which is fully
dynamic — never created/destroyed per connect (SPEC.md §2, §6.4).

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
- Reverse-proxies HTTP requests for Iris/Mopidy's web interface at a
  plugin-owned path, so the browser never needs to know the container's
  internal port.
- Subscribes to Mopidy's JSON-RPC event stream (not just polling) for
  playback state, writing every change into the canonical store (§2.1);
  applies canonical-store writes that originated elsewhere (N2K, REST) to
  Mopidy via the same JSON-RPC API.
- Periodically snapshots the tracklist/position for restart persistence
  (SPEC.md §8), and restores it into Mopidy on the next container start
  before the store is considered "ready."
- Polls Snapserver's JSON-RPC control API for connected clients and
  their volume/mute, writing zone state into the canonical store;
  applies zone volume/mute writes that originated elsewhere to Snapserver
  the same way.
- **Manages the AirPlay slot pool** (SPEC.md §6.4 — revised after
  research confirmed Snapcast blocks runtime creation of `airplay`/
  `process`-type streams, SPEC.md §13): at container start, ensures
  `airplay.maxZones` streams exist in Snapserver's static config, each
  spawning its own `shairport-sync`. On a **brand-new** zone's first
  discovery, claims the next free slot, persists the assignment
  (`ZoneAssignment.airplaySlot`), regenerates Snapserver's config with
  that slot's real zone name, and triggers a one-time Snapserver restart.
  On every subsequent connect/disconnect of an **already-claimed** zone,
  binds/unbinds its Snapclient to its already-named slot via
  `Group.SetClients`/`SetStream` — no restart, no config change. Also
  watches for a zone's group switching which stream it's attached to
  (Jukebox ↔ that zone's claimed AirPlay slot) and writes the resulting
  `activeSource` into canonical state (§2.1).
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
- **Outbound:** on every canonical-store change event, encodes the
  relevant Fusion-Link message (and, best-effort, the standard
  Entertainment PGN equivalent) and sends it via
  `app.emit('nmea2000out', pgnString)`, per SignalK's standard
  N2K-output convention. Also re-broadcasts current state on a periodic
  interval so a device joining the bus mid-session gets it without
  waiting for the next change (SPEC.md §6.3).
- **Inbound:** subscribes to incoming N2K PGNs via SignalK's PGN-in hook,
  decodes Fusion-Link commands (transport, master volume, per-zone
  volume/mute), and writes them into the canonical store the same way any
  other adapter's incoming command would be applied (§2.1) — the store
  doesn't know or care that the write came from the N2K bus rather than
  REST.
- **Zone mapping:** reads/writes `ZoneAssignment` (§2.1) to translate
  between Snapclient ids (used everywhere else) and the small integer
  zone numbers (0–3) Fusion-Link/Entertainment PGNs actually carry.
- Entirely optional — when `n2k.enabled` is `false` (SPEC.md §9), this
  adapter does not run; every other component is unaffected (the store
  and its other adapters have no dependency on N2K being present).

### 2.4 Container image (`signalk-jukebox` image, built by this repo)

- Mopidy + Mopidy-Local + Mopidy-TuneIn (or chosen radio extension) +
  Mopidy-Spotify, all installed; each backend individually
  enabled/disabled by config the plugin writes into Mopidy's config file
  before/at container start.
- Iris installed as Mopidy's web frontend.
- Snapserver, configured to receive Mopidy's audio output as its source
  and expose the Snapcast stream + JSON-RPC control API.
- The one piece built from scratch for this project — no existing image
  bundles Mopidy+Snapcast+Iris together the way this needs. Follows the
  precedent of signalk-wyoming's purpose-built `wyoming-satellite` image
  for the same "glue upstream processes together" reason.

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
| Web client             | Iris                                                                                                                                                 | Existing, full-featured Mopidy web client — avoids building a competing player UI (SPEC.md §12)                                                                                                                                     |
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
  volume/mute control, and dynamic client↔group/stream reassignment for
  the AirPlay pool (SPEC.md §6.4). **Confirmed via research (SPEC.md
  §13, current stable Snapcast v0.35.0):** `Stream.AddStream`/
  `RemoveStream` exist but are restricted to `pipe`/`file`/`tcp`/`alsa`/
  `jack`/`meta` — `process`-type streams (`airplay` included) were
  deliberately excluded as part of the CVE-2023-36177 fix (arbitrary
  command execution via the stream-add RPC), and there is no
  `Group.Create`/`Delete` RPC at all. Only `Group.SetClients`/
  `Group.SetStream` (reassigning an existing client between existing
  groups/streams) is fully dynamic — which is what the pool design in
  §2.2 relies on; creating a new named AirPlay stream still requires a
  Snapserver config change + restart. Contract: Snapcast's documented
  JSON-RPC protocol (`doc/json_rpc_api/control.md` in the Snapcast repo,
  now at `snapcast/snapcast` — moved from `badaix/snapcast`).
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
- **Iris/Mopidy reverse-proxied, not directly exposed** — the plugin
  fronts it so it rides the same network exposure as the rest of the
  SignalK Admin UI rather than opening a separate port.
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
- **Snapserver's `Stream.AddStream`/`RemoveStream` RPC type whitelist
  (SPEC.md §13) exists specifically because unrestricted process-stream
  creation was a real, exploited-class vulnerability (CVE-2023-36177,
  arbitrary command execution).** This plugin must never work around
  that restriction (e.g. by shelling out to add a raw `process://`
  stream some other way) — the pool-based design (§2.2) exists in part
  _because_ that path is deliberately closed, not merely inconvenient.

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
│   ├── n2k/
│   │   ├── fusion.ts          # Fusion-Link encode/decode + address claiming
│   │   ├── entertainment-pgn.ts # standard NMEA2000 Entertainment PGN encode/decode
│   │   └── zone-mapping.ts    # Snapclient id <-> n2kZone persistence (§2.1)
│   ├── airplay/
│   │   ├── pool.ts             # static N-slot stream config generation + Snapserver restart-on-claim (§2.2, §6.4)
│   │   └── zone-binding.ts     # dynamic Group.SetClients/SetStream bind/unbind, no restart (§2.2, §6.4)
│   ├── duck-triggers/
│   │   ├── vhf.ts              # communication.vhf.busy -> Mopidy pause/resume (§2.5, SPEC.md §6.5)
│   │   └── voice.ts            # voice.satellites.*.state -> zone volume duck/restore (§2.5, SPEC.md §6.5)
│   ├── routes.ts              # /api/* Express routes
│   ├── paths.ts                # entertainment.* SK path publishing
│   ├── configpanel/            # React admin panel (signalk-container-helper/ui)
│   └── types.ts
├── image/                     # the custom Mopidy+Snapserver+Iris container image
│   ├── Dockerfile
│   └── mopidy.conf.template
├── test/
└── webpack.config.cjs         # config-panel remote build (ESM, per container-helper's UI notes)
```

## 8. Deployment

- Installed as a SignalK plugin (App Store or `npm install`), requiring
  **signalk-container** with a working docker/podman runtime — same
  prerequisite chain as any `ManagedContainer`-based plugin.
- The `signalk-jukebox` container image is published separately (e.g.
  `ghcr.io/<org>/signalk-jukebox`) and pulled by signalk-container the
  same way any managed image is.
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

- **wyoming-satellite as a second zone backend type** — would introduce a
  `ZoneBackend` seam (Snapcast vs. satellite-control-API) analogous to
  signalk-wyoming's `Satellite` interface, so the zone list/volume API in
  §5/SPEC.md §6.1 wouldn't need to change shape, only gain a second
  implementation behind it. Deferred until wyoming-satellite's control
  API is stable enough to build against (SPEC.md §13).
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
  alongside `src/airplay/`; whichever is chosen should reuse the same
  _pooled-slot-with-persisted-claim_ pattern (§2.2, §6.4) rather than
  assume dynamic runtime stream creation is available — Snapcast's
  security-motivated RPC restriction (§5) is a Snapcast property, not an
  `airplay`-specific one, and would very likely apply equally to however
  a Cast/Bluetooth/DLNA source gets fed into Snapcast.
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
- **AirPlay now-playing metadata surfaced further** (SPEC.md §13) — if
  the "stale info during someone else's AirPlay session" gap proves
  annoying, `shairport-sync`'s metadata pipe could feed track/artist into
  canonical state per zone the same way Mopidy's does today, extending
  `Zone.airplay` (SPEC.md §4) rather than replacing it.
