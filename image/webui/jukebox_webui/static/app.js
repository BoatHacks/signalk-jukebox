// Relative, not "/mopidy/rpc" -- this page is served from the container's
// own /jukebox/ when hit directly, but from .../jukebox/ behind an
// arbitrary mount prefix when reverse-proxied (e.g. this project's own
// plugin, src/proxy.ts). An absolute path resolves against the browser's
// current origin and skips any such proxy prefix entirely; confirmed by
// build-testing (SPEC.md §13) that this showed as a permanently
// "Disconnected" UI despite the container and proxy both actually being
// healthy. "../mopidy/rpc" resolves correctly in both cases.
const RPC_URL = "../mopidy/rpc";
let rpcId = 0;

async function rpc(method, params) {
  rpcId += 1;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params || {} }),
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

els.volume.addEventListener("mousedown", () => { userIsDraggingVolume = true; });
els.volume.addEventListener("touchstart", () => { userIsDraggingVolume = true; });

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
