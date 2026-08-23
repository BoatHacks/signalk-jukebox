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
    const [state, track, volume] = await Promise.all([
      rpc("core.playback.get_state"),
      rpc("core.playback.get_current_track"),
      rpc("core.mixer.get_volume"),
    ]);

    els.statusDot.classList.add("ok");
    lastState = state;
    els.state.textContent = state;
    els.playPauseBtn.textContent = state === "playing" ? "⏸" : "▶";

    if (track) {
      els.track.textContent = track.name || "(untitled)";
      const artists = (track.artists || []).map((a) => a.name).join(", ");
      els.artist.textContent = artists;
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

refresh();
setInterval(refresh, 2000);

// --- Zones (source/zone picker) -------------------------------------------
// API_BASE + "/api/zones" is this plugin's own REST route (routes.ts), not
// proxied through to the container the way RPC_URL is -- on this copy of
// the file (served by the container itself), it only resolves when this
// page is reached through the plugin's reverse proxy, not when hitting the
// container's own port directly. That's expected: zone/source control
// needs the plugin's Snapserver connection, which only exists on the
// proxied path. public/app.js's absolute API_BASE resolves this
// unconditionally, since it always goes through the plugin's own router.
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
      <button class="play-here">Play here</button>
      <input type="range" min="0" max="100" value="0">
      <span class="volume-value">0%</span>
      <button class="mute-btn">Mute</button>
    </div>
  `;
  const nameDot = row.querySelector(".status-dot");
  const nameText = row.querySelector(".name-text");
  const sourceBadge = row.querySelector(".zone-source");
  const playBtn = row.querySelector(".play-here");
  const volumeInput = row.querySelector("input[type=range]");
  const volumeValue = row.querySelector(".volume-value");
  const muteBtn = row.querySelector(".mute-btn");

  // A toggle, not a one-way switch: while this zone is already playing the
  // jukebox stream unmuted, clicking again turns it off (mutes it) rather
  // than doing nothing -- the only other source a zone can hold
  // (per-zone AirPlay) is switched to automatically on connect, never
  // manually (routes.ts), so "off" here means "stop this zone hearing the
  // jukebox stream", which is what muting it actually does.
  playBtn.addEventListener("click", async () => {
    const entry = zoneRows.get(zone.id);
    const isPlayingHere =
      entry.lastActiveSource === "jukebox" && !entry.lastMuted;
    if (isPlayingHere) {
      await zonePost(zone.id, "mute", { muted: true });
    } else {
      await zonePost(zone.id, "source", { source: "jukebox" });
      if (entry.lastMuted) {
        await zonePost(zone.id, "mute", { muted: false });
      }
    }
    refreshZones();
  });

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
    refreshZones();
  });

  muteBtn.addEventListener("click", async () => {
    const entry = zoneRows.get(zone.id);
    const nextMuted = !entry.lastMuted;
    await zonePost(zone.id, "mute", { muted: nextMuted });
    refreshZones();
  });

  return {
    row,
    nameDot,
    nameText,
    sourceBadge,
    playBtn,
    volumeInput,
    volumeValue,
    muteBtn,
    lastMuted: false,
    lastActiveSource: undefined,
  };
}

function updateZoneRow(entry, zone) {
  entry.nameDot.classList.toggle("ok", zone.connected);
  entry.nameText.textContent = zone.name || zone.id;
  entry.sourceBadge.textContent =
    zone.activeSource === "jukebox" ? "Jukebox" : "AirPlay";
  entry.sourceBadge.className = `zone-source ${zone.activeSource}`;
  entry.lastActiveSource = zone.activeSource;
  const isPlayingHere = zone.activeSource === "jukebox" && !zone.muted;
  entry.playBtn.textContent = isPlayingHere ? "Stop" : "Play here";
  entry.playBtn.classList.toggle("on", isPlayingHere);
  if (!draggingZoneVolumes.has(zone.id)) {
    entry.volumeInput.value = zone.volume;
    entry.volumeValue.textContent = `${zone.volume}%`;
  }
  entry.lastMuted = zone.muted;
  entry.muteBtn.textContent = zone.muted ? "Unmute" : "Mute";
  entry.muteBtn.classList.toggle("muted", zone.muted);
}

async function refreshZones() {
  try {
    const res = await fetch(ZONES_URL);
    if (!res.ok) throw new Error("zones unavailable");
    const zones = await res.json();
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
  } catch {
    // Zone control isn't available on this path (e.g. hitting the
    // container directly, not through the plugin's proxy) -- leave
    // whatever was last shown rather than clearing it on a blip.
  }
}

everywhereBtn.addEventListener("click", async () => {
  await Promise.all(
    lastZones.map((zone) =>
      zonePost(zone.id, "source", { source: "jukebox" }).catch(() => {}),
    ),
  );
  refreshZones();
});

document.getElementById("musicboxLink").href =
  `http://${location.hostname}:${MOPIDY_PORT}/musicbox_webclient/`;
document.getElementById("snapwebLink").href =
  `http://${location.hostname}:${SNAPWEB_PORT}/`;

refreshZones();
setInterval(refreshZones, 2000);
