// Served statically by signalk-server itself at /signalk-jukebox/ (the
// "signalk-webapp" mount, public/index.html), not reverse-proxied through
// the container. API_BASE is a real absolute path (not ".."), since this
// page's own URL has nothing to do with where the plugin's router is
// mounted: it always needs /plugins/signalk-jukebox regardless.
const API_BASE = "/plugins/signalk-jukebox";
const RPC_URL = `${API_BASE}/mopidy/rpc`;
let rpcId = 0;

// Mirrors container.ts's own MOPIDY_PORT/SNAPWEB_PORT (this static file has
// no build step to import them through). Both Mopidy-MusicBox-Webclient and
// Snapweb are reached directly against these published ports, not through
// this plugin's own reverse proxy -- their UIs are WebSocket-driven, which
// proxy.ts can't forward (no access to the raw http.Server via
// registerWithRouter's Express Router). `location.hostname` gives the same
// LAN-reachable host this page itself was loaded from.
const MOPIDY_PORT = 6680;
const SNAPWEB_PORT = 1780;

async function rpc(method, params) {
  rpcId += 1;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method,
      params: params || {},
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "RPC error");
  return body.result;
}

const els = {
  track: document.getElementById("track"),
  artist: document.getElementById("artist"),
  state: document.getElementById("state"),
  statusDot: document.getElementById("statusDot"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  volume: document.getElementById("volume"),
  volumeValue: document.getElementById("volumeValue"),
  uriInput: document.getElementById("uriInput"),
  playUriBtn: document.getElementById("playUriBtn"),
};

let userIsDraggingVolume = false;
let lastState = "stopped";

async function refresh() {
  try {
    const [state, track, streamTitle, volume] = await Promise.all([
      rpc("core.playback.get_state"),
      rpc("core.playback.get_current_track"),
      // For a radio stream, track.name is the STATIC station metadata baked
      // into the stream URI itself (e.g. "Groove Salad: a nicely chilled
      // plate of ambient beats and grooves. [SomaFM]") -- it never changes
      // for as long as that station plays. The actual currently-playing
      // song ("zero cult - seclusion") is separate, live ICY metadata
      // Mopidy surfaces only through this call, not get_current_track.
      // null for anything that isn't a stream (local files, Spotify), where
      // track.name/artists already are the real per-song info.
      rpc("core.playback.get_stream_title"),
      rpc("core.mixer.get_volume"),
    ]);

    els.statusDot.classList.add("ok");
    lastState = state;
    els.state.textContent = state;
    els.playPauseBtn.textContent = state === "playing" ? "⏸" : "▶";

    if (track) {
      if (streamTitle) {
        els.track.textContent = streamTitle;
        els.artist.textContent = track.name || "";
      } else {
        els.track.textContent = track.name || "(untitled)";
        const artists = (track.artists || []).map((a) => a.name).join(", ");
        els.artist.textContent = artists;
      }
    } else {
      els.track.textContent = "Nothing playing";
      els.artist.textContent = "";
    }

    if (!userIsDraggingVolume && volume !== null && volume !== undefined) {
      els.volume.value = volume;
      els.volumeValue.textContent = `${volume}%`;
    }
  } catch (err) {
    els.statusDot.classList.remove("ok");
    els.state.textContent = "disconnected";
  }
}

els.playPauseBtn.addEventListener("click", async () => {
  if (lastState === "playing") {
    await rpc("core.playback.pause");
  } else {
    await rpc("core.playback.play");
  }
  refresh();
});

els.prevBtn.addEventListener("click", async () => {
  await rpc("core.playback.previous");
  refresh();
});

els.nextBtn.addEventListener("click", async () => {
  await rpc("core.playback.next");
  refresh();
});

els.volume.addEventListener("mousedown", () => {
  userIsDraggingVolume = true;
});
els.volume.addEventListener("touchstart", () => {
  userIsDraggingVolume = true;
});

els.volume.addEventListener("change", async (e) => {
  await rpc("core.mixer.set_volume", { volume: Number(e.target.value) });
  userIsDraggingVolume = false;
  refresh();
});

els.volume.addEventListener("input", (e) => {
  els.volumeValue.textContent = `${e.target.value}%`;
});

els.playUriBtn.addEventListener("click", async () => {
  const uri = els.uriInput.value.trim();
  if (!uri) return;
  const tlTracks = await rpc("core.tracklist.add", { uris: [uri] });
  if (tlTracks && tlTracks.length > 0) {
    await rpc("core.playback.play", { tlid: tlTracks[0].tlid });
  }
  els.uriInput.value = "";
  refresh();
});

// Live updates: Mopidy's own WebSocket (ws://<host>:6680/mopidy/ws, same
// direct-port bypass as MOPIDY_PORT/SNAPWEB_PORT above -- proxy.ts can't
// forward this). Confirmed by connecting to the live container: every
// core event Mopidy pushes here arrives as flat JSON with an "event" key
// alongside its own data (e.g. {"volume":42,"event":"volume_changed"}),
// NOT wrapped as a JSON-RPC notification -- so events are told apart from
// RPC responses (which always carry an "id") by the absence of one.
// Rather than hand-apply each event's own partial shape, any relevant
// event just re-runs the same refresh() used for the initial load --
// infrequent (only on a real change, not a timer) and reuses
// already-correct display logic instead of duplicating it.
const MOPIDY_WS_URL = `ws://${location.hostname}:${MOPIDY_PORT}/mopidy/ws`;
const RELEVANT_MOPIDY_EVENTS = new Set([
  "playback_state_changed",
  "track_playback_started",
  "track_playback_resumed",
  "track_playback_paused",
  "track_playback_ended",
  "stream_title_changed",
  "volume_changed",
  "tracklist_changed",
]);
let mopidyRefreshDebounce = null;

function scheduleMopidyRefresh() {
  clearTimeout(mopidyRefreshDebounce);
  mopidyRefreshDebounce = setTimeout(refresh, 50);
}

function connectMopidyWs() {
  const ws = new WebSocket(MOPIDY_WS_URL);
  ws.addEventListener("open", () => refresh());
  ws.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.event && RELEVANT_MOPIDY_EVENTS.has(data.event)) {
      scheduleMopidyRefresh();
    }
  });
  ws.addEventListener("close", () => {
    els.statusDot.classList.remove("ok");
    els.state.textContent = "disconnected";
    setTimeout(connectMopidyWs, 2000);
  });
  ws.addEventListener("error", () => ws.close());
}

refresh();
connectMopidyWs();

// --- Zones (source/zone picker) -------------------------------------------
// Mutations (source/volume/mute) still go through this plugin's own proxied
// REST route (routes.ts) -- that's what actually holds the authenticated
// Snapserver control connection, and it's what enforces the three-value
// "jukebox"/"alerts"/"silence" contract. ZONES_URL is only used for that;
// live status is no longer polled from it (see SNAPCAST_WS_URL below).
const ZONES_URL = `${API_BASE}/api/zones`;

const zoneList = document.getElementById("zoneList");
const everywhereBtn = document.getElementById("everywhereBtn");
const zoneRows = new Map(); // zone id -> { row, volumeInput, muteBtn, playBtn, sourceBadge, nameDot }
const draggingZoneVolumes = new Set();
let lastZones = [];

async function zonePost(id, path, body) {
  const res = await fetch(`${ZONES_URL}/${encodeURIComponent(id)}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${path} failed`);
  }
}

function buildZoneRow(zone) {
  const row = document.createElement("div");
  row.className = "zone-row";
  row.innerHTML = `
    <div class="zone-top">
      <span class="zone-name"><span class="status-dot"></span><span class="name-text"></span></span>
      <span class="zone-source"></span>
    </div>
    <div class="zone-controls">
      <div class="source-buttons">
        <button class="source-btn jukebox" data-source="jukebox">MusicAndAlerts</button>
        <button class="source-btn alerts" data-source="alerts">Alerts</button>
        <button class="source-btn silence" data-source="silence">Silence</button>
      </div>
      <input type="range" min="0" max="100" value="0">
      <span class="volume-value">0%</span>
      <button class="mute-btn">Mute</button>
      <button class="delete-btn hidden" title="Forget this zone -- only available while it's offline">Delete</button>
    </div>
  `;
  const nameDot = row.querySelector(".status-dot");
  const nameText = row.querySelector(".name-text");
  const sourceBadge = row.querySelector(".zone-source");
  const sourceButtons = Array.from(row.querySelectorAll(".source-btn"));
  const volumeInput = row.querySelector("input[type=range]");
  const volumeValue = row.querySelector(".volume-value");
  const muteBtn = row.querySelector(".mute-btn");
  const deleteBtn = row.querySelector(".delete-btn");

  // Three exclusive states, not a toggle: "jukebox" is the auto-ducking
  // combined stream (routes.ts's JUKEBOX_STREAM_ID, "MusicAndAlerts"
  // underneath -- hears the shared music, automatically interrupted for an
  // announcement, then automatically resumed); "alerts" hears ONLY
  // announcements, no jukebox at all, without muting the whole Snapclient;
  // "silence" hears nothing at all, not even announcements, e.g. a
  // sleeping cabin. AirPlay is the only source this can't set manually:
  // it's switched to automatically on connect (routes.ts), never chosen
  // here.
  for (const btn of sourceButtons) {
    btn.addEventListener("click", async () => {
      await zonePost(zone.id, "source", { source: btn.dataset.source });
    });
  }

  volumeInput.addEventListener("mousedown", () =>
    draggingZoneVolumes.add(zone.id),
  );
  volumeInput.addEventListener("touchstart", () =>
    draggingZoneVolumes.add(zone.id),
  );
  volumeInput.addEventListener("input", (e) => {
    volumeValue.textContent = `${e.target.value}%`;
  });
  volumeInput.addEventListener("change", async (e) => {
    await zonePost(zone.id, "volume", { volume: Number(e.target.value) });
    draggingZoneVolumes.delete(zone.id);
  });

  muteBtn.addEventListener("click", async () => {
    const entry = zoneRows.get(zone.id);
    const nextMuted = !entry.lastMuted;
    await zonePost(zone.id, "mute", { muted: nextMuted });
  });

  // Only ever shown/enabled for a zone that's currently offline
  // (updateZoneRow's "hidden" toggle) -- routes.ts's own 409 is the real
  // guard, this is just to not offer the button for a live zone at all.
  // Removes the row immediately on success rather than waiting for the
  // next Snapcast push, since a deleted client produces no further
  // notification about itself to wait for.
  deleteBtn.addEventListener("click", async () => {
    const entry = zoneRows.get(zone.id);
    if (
      !confirm(
        `Forget "${entry.nameText.textContent}"? This can't be undone -- it'll come back on its own if it ever reconnects.`,
      )
    ) {
      return;
    }
    try {
      await zonePost(zone.id, "delete", {});
      entry.row.remove();
      zoneRows.delete(zone.id);
    } catch (err) {
      alert(`Couldn't delete this zone: ${err.message}`);
    }
  });

  return {
    row,
    nameDot,
    nameText,
    sourceBadge,
    sourceButtons,
    volumeInput,
    volumeValue,
    muteBtn,
    deleteBtn,
    lastMuted: false,
    lastActiveSource: undefined,
  };
}

function updateZoneRow(entry, zone) {
  entry.nameDot.classList.toggle("ok", zone.connected);
  entry.nameText.textContent = zone.name || zone.id;
  entry.sourceBadge.textContent =
    zone.activeSource === "jukebox"
      ? "MusicAndAlerts"
      : zone.activeSource === "alerts"
        ? "Alerts"
        : zone.activeSource === "silence"
          ? "Silence"
          : "AirPlay";
  entry.sourceBadge.className = `zone-source ${zone.activeSource}`;
  entry.lastActiveSource = zone.activeSource;
  for (const btn of entry.sourceButtons) {
    btn.classList.toggle("on", btn.dataset.source === zone.activeSource);
  }
  if (!draggingZoneVolumes.has(zone.id)) {
    entry.volumeInput.value = zone.volume;
    entry.volumeValue.textContent = `${zone.volume}%`;
  }
  entry.lastMuted = zone.muted;
  entry.muteBtn.textContent = zone.muted ? "Unmute" : "Mute";
  entry.muteBtn.classList.toggle("muted", zone.muted);
  entry.deleteBtn.classList.toggle("hidden", zone.connected);
}

// zone.id/name/connected/volume/muted are exactly Snapcast's own
// client.id/client.config.name/client.connected/client.config.volume.
// activeSource is derived the same way zone-sync.ts derives it server-side
// (JUKEBOX_STREAM_ID/ALERTS_STREAM_ID/SILENCE_STREAM_ID, else "airplay") --
// duplicated here because this renders directly from Snapserver's own raw
// status, not from routes.ts's already-computed /api/zones shape.
function renderZonesFromServer(server) {
  const zones = [];
  for (const group of server.groups || []) {
    const activeSource =
      group.stream_id === "MusicAndAlerts"
        ? "jukebox"
        : group.stream_id === "Alerts"
          ? "alerts"
          : group.stream_id === "Silence"
            ? "silence"
            : "airplay";
    for (const client of group.clients || []) {
      zones.push({
        id: client.id,
        name: client.config.name,
        connected: client.connected,
        volume: client.config.volume.percent,
        muted: client.config.volume.muted,
        activeSource,
      });
    }
  }
  lastZones = zones;

  const seen = new Set();
  for (const zone of zones) {
    seen.add(zone.id);
    let entry = zoneRows.get(zone.id);
    if (!entry) {
      entry = buildZoneRow(zone);
      zoneRows.set(zone.id, entry);
      zoneList.appendChild(entry.row);
    }
    updateZoneRow(entry, zone);
  }
  for (const [id, entry] of zoneRows) {
    if (!seen.has(id)) {
      entry.row.remove();
      zoneRows.delete(id);
    }
  }
  if (zones.length === 0) {
    zoneList.innerHTML = '<div class="zone-empty">No zones connected</div>';
  } else if (zoneList.querySelector(".zone-empty")) {
    zoneList.innerHTML = "";
    for (const entry of zoneRows.values()) zoneList.appendChild(entry.row);
  }
}

everywhereBtn.addEventListener("click", async () => {
  await Promise.all(
    lastZones.map((zone) =>
      zonePost(zone.id, "source", { source: "jukebox" }).catch(() => {}),
    ),
  );
});

document.getElementById("musicboxLink").href =
  `http://${location.hostname}:${MOPIDY_PORT}/musicbox_webclient/`;
document.getElementById("snapwebLink").href =
  `http://${location.hostname}:${SNAPWEB_PORT}/`;

// Live zone status: Snapserver's own WebSocket JSON-RPC endpoint, the same
// port ("/jsonrpc" on SNAPWEB_PORT) Snapweb itself already uses -- another
// direct-port bypass of proxy.ts, same reasoning as MOPIDY_WS_URL above.
// Confirmed live: mutations (e.g. Group.SetMute, issued here via zonePost
// against the plugin's own authenticated route, not this socket) produce a
// specific push notification (e.g. {"jsonrpc":"2.0","method":"Group.OnMute",
// "params":{...}}), not a uniform "Server.OnUpdate" with the full state --
// Snapcast's docs show Server.OnUpdate accompanying only some requests
// (e.g. Group.SetClients). Rather than hand-apply each notification's own
// shape, any notification (no "id", has a "method") just re-requests
// Server.GetStatus and re-renders from that -- same "re-run the known-good
// renderer on a change signal" approach as the Mopidy side.
const SNAPCAST_WS_URL = `ws://${location.hostname}:${SNAPWEB_PORT}/jsonrpc`;
let snapRpcId = 0;

function connectSnapWs() {
  const ws = new WebSocket(SNAPCAST_WS_URL);
  const send = (method) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    snapRpcId += 1;
    ws.send(JSON.stringify({ id: snapRpcId, jsonrpc: "2.0", method }));
  };
  ws.addEventListener("open", () => send("Server.GetStatus"));
  ws.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.result && data.result.server) {
      renderZonesFromServer(data.result.server);
    } else if (data.method) {
      send("Server.GetStatus");
    }
  });
  ws.addEventListener("close", () => {
    // Leave whatever was last shown rather than clearing it on a blip (e.g.
    // hitting the container directly, not through the plugin's proxy, where
    // this port isn't reachable at all).
    setTimeout(connectSnapWs, 2000);
  });
  ws.addEventListener("error", () => ws.close());
}

connectSnapWs();
