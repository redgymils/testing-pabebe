const els = {
  video: document.getElementById("video"),
  stage: document.getElementById("videoStage"),
  controlBar: document.getElementById("controlBar"),
  channelGrid: document.getElementById("channelGrid"),
  drawerList: document.getElementById("drawerList"),
  drawer: document.getElementById("drawer"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  openDrawerBtn: document.getElementById("openDrawerBtn"),
  closeDrawerBtn: document.getElementById("closeDrawerBtn"),
  overlayChannelName: document.getElementById("overlayChannelName"),
  qualitySelect: document.getElementById("qualitySelect"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  playIcon: document.getElementById("playIcon"),
  muteBtn: document.getElementById("muteBtn"),
  volIcon: document.getElementById("volIcon"),
  volumeSlider: document.getElementById("volumeSlider"),
  liveSyncBtn: document.getElementById("liveSyncBtn"),
  pipBtn: document.getElementById("pipBtn"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  retryBtn: document.getElementById("retryBtn"),
  errorMsg: document.getElementById("errorMsg"),
  statusPill: document.getElementById("statusPill"),
  statusText: document.getElementById("statusText"),
  topTelemetry: document.getElementById("topTelemetry"),
  statRes: document.getElementById("statRes"),
  statBitrate: document.getElementById("statBitrate")
};

let player;
let currentIndex = 0;
let hideControlsTimer = null;

function renderChannelUI() {
  els.channelGrid.innerHTML = CHANNELS.map((ch, i) => `
    <button class="channel-card" data-index="${i}">
      <div class="card-top">
        <span class="cam-code">${ch.code}</span>
        <span class="card-dot"></span>
      </div>
      <div class="cam-name">${ch.name}</div>
      <div class="cam-meta">${ch.desc}</div>
    </button>
  `).join("");

  els.drawerList.innerHTML = CHANNELS.map((ch, i) => `
    <button class="drawer-item" data-index="${i}">
      <span>${ch.name}</span>
      <span class="cam-code">${ch.code}</span>
    </button>
  `).join("");

  els.channelGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".channel-card");
    if (card) switchStream(Number(card.dataset.index));
  });

  els.drawerList.addEventListener("click", (e) => {
    const item = e.target.closest(".drawer-item");
    if (item) {
      switchStream(Number(item.dataset.index));
      toggleDrawer(false);
    }
  });
}

function setOnlineStatus(isOnline, label = isOnline ? "Online" : "Offline") {
  els.statusPill.classList.toggle("offline", !isOnline);
  els.statusText.textContent = label;
}

function showControls(autoHide = true) {
  els.stage.classList.add("controls-visible");
  clearTimeout(hideControlsTimer);
  if (autoHide && !els.video.paused) {
    hideControlsTimer = setTimeout(() => {
      els.stage.classList.remove("controls-visible");
    }, 3000);
  }
}

function toggleDrawer(open) {
  els.drawer.classList.toggle("open", open);
  els.drawerBackdrop.classList.toggle("open", open);
}

function updatePlayIcon() {
  els.playIcon.innerHTML = els.video.paused
    ? '<polygon points="6 4 20 12 6 20 6 4"/>'
    : '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>';
}

function updateVolumeIcon() {
  const muted = els.video.muted || els.video.volume === 0;
  els.volIcon.innerHTML = muted
    ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
    : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
}

function populateQualities() {
  const tracks = player.getVariantTracks();
  const uniqueHeights = [...new Set(tracks.map((t) => t.height).filter(Boolean))].sort((a, b) => b - a);

  els.qualitySelect.innerHTML = '<option value="auto">Auto Quality</option>';
  uniqueHeights.forEach((h) => {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = `${h}p`;
    els.qualitySelect.appendChild(opt);
  });
}

function updateTelemetry() {
  if (!player) return;
  const active = player.getVariantTracks().find((t) => t.active);
  if (!active) return;

  const res = active.height ? `${active.height}p` : "Live";
  const mbps = active.bandwidth ? `${(active.bandwidth / 1_000_000).toFixed(1)} Mbps` : "—";
  const mode = els.qualitySelect.value === "auto" ? "Auto" : "Manual";

  els.statRes.textContent = active.width && active.height ? `${active.width}×${active.height}` : res;
  els.statBitrate.textContent = mbps;
  els.topTelemetry.textContent = `${res} • ${mode}`;
}

async function switchStream(index) {
  currentIndex = index;
  const channel = CHANNELS[index];

  document.querySelectorAll(".channel-card, .drawer-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.index) === index);
  });

  els.overlayChannelName.textContent = channel.name;
  els.qualitySelect.value = "auto";
  els.stage.classList.remove("has-error");
  els.stage.classList.add("is-loading");
  setOnlineStatus(true, "Connecting");

  player.configure({
    drm: { clearKeys: { [channel.kid]: channel.key } },
    abr: { enabled: true }
  });

  try {
    await player.load(channel.url);
    populateQualities();
    updateTelemetry();
    setOnlineStatus(true, "Online");

    const playPromise = els.video.play();
    if (playPromise) {
      playPromise.catch(() => {
        els.video.muted = true;
        updateVolumeIcon();
        els.video.play().catch(() => {});
      });
    }
  } catch (err) {
    console.error("Stream load error:", err);
    els.stage.classList.remove("is-loading");
    els.stage.classList.add("has-error");
    els.errorMsg.textContent = `Could not connect to ${channel.name}. Tap retry to reconnect.`;
    setOnlineStatus(false, "Offline");
  }
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (els.stage.requestFullscreen) {
        await els.stage.requestFullscreen();
      } else if (els.stage.webkitRequestFullscreen) {
        els.stage.webkitRequestFullscreen();
      }
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(() => {});
      }
    } else {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  } catch (e) {
    console.warn("Fullscreen error:", e);
  }
}

function bindEvents() {
  els.stage.addEventListener("click", (e) => {
    if (e.target.closest("#controlBar, .overlay-top, .error-card")) {
      showControls(true);
      return;
    }
    if (els.stage.classList.contains("controls-visible")) {
      els.stage.classList.remove("controls-visible");
      clearTimeout(hideControlsTimer);
    } else {
      showControls(true);
    }
  });

  els.playPauseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.video.paused ? els.video.play() : els.video.pause();
    showControls(true);
  });

  els.video.addEventListener("play", () => { updatePlayIcon(); showControls(true); });
  els.video.addEventListener("pause", () => { updatePlayIcon(); showControls(false); });
  els.video.addEventListener("waiting", () => els.stage.classList.add("is-loading"));
  els.video.addEventListener("playing", () => {
    els.stage.classList.remove("is-loading", "has-error");
    setOnlineStatus(true, "Online");
    updateTelemetry();
  });

  els.muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.video.muted = !els.video.muted;
    els.volumeSlider.value = els.video.muted ? 0 : els.video.volume;
    updateVolumeIcon();
  });

  els.volumeSlider.addEventListener("input", (e) => {
    e.stopPropagation();
    els.video.volume = Number(e.target.value);
    els.video.muted = els.video.volume === 0;
    updateVolumeIcon();
  });

  els.liveSyncBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const range = player.seekRange();
    if (range && range.end > 0) {
      els.video.currentTime = Math.max(range.start, range.end - 1);
      els.video.play().catch(() => {});
    }
  });

  els.qualitySelect.addEventListener("change", (e) => {
    e.stopPropagation();
    const val = e.target.value;
    if (val === "auto") {
      player.configure({ abr: { enabled: true } });
    } else {
      const targetHeight = Number(val);
      const match = player.getVariantTracks().find((t) => t.height === targetHeight);
      if (match) {
        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(match, true);
      }
    }
    updateTelemetry();
  });

  els.pipBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await els.video.requestPictureInPicture().catch(() => {});
    }
  });

  els.fullscreenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch (_) {}
    }
  });

  els.reloadBtn.addEventListener("click", () => switchStream(currentIndex));
  els.retryBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    switchStream(currentIndex);
  });

  els.openDrawerBtn.addEventListener("click", () => toggleDrawer(true));
  els.closeDrawerBtn.addEventListener("click", () => toggleDrawer(false));
  els.drawerBackdrop.addEventListener("click", () => toggleDrawer(false));

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === "Escape") toggleDrawer(false);
    if (e.code === "Space") { e.preventDefault(); els.video.paused ? els.video.play() : els.video.pause(); }
    if (e.key.toLowerCase() === "m") { els.video.muted = !els.video.muted; updateVolumeIcon(); }
    if (e.key.toLowerCase() === "f") toggleFullscreen();
    if (["1", "2", "3", "4"].includes(e.key)) switchStream(Number(e.key) - 1);
  });
}

async function initApp() {
  renderChannelUI();
  bindEvents();
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    els.stage.classList.remove("is-loading");
    els.stage.classList.add("has-error");
    els.errorMsg.textContent = "This browser does not support Shaka Player.";
    setOnlineStatus(false, "Unsupported");
    return;
  }

  player = new shaka.Player();
  await player.attach(els.video);

  // Fast live-startup & low-latency configuration
  player.configure({
    abr: {
      enabled: true,
      defaultBandwidthEstimate: 2_500_000,
      switchInterval: 4
    },
    streaming: {
      lowLatencyMode: true,
      bufferingGoal: 6,
      rebufferingGoal: 1,
      inaccurateManifestTolerance: 0,
      retryParameters: { maxAttempts: 4, baseDelay: 500, backoffFactor: 2 }
    },
    manifest: {
      dash: {
        ignoreMinBufferTime: true
      }
    }
  });

  player.addEventListener("error", (event) => {
    console.error("Shaka Error:", event.detail);
  });

  player.addEventListener("adaptation", updateTelemetry);

  switchStream(0);
}

document.addEventListener("DOMContentLoaded", initApp);
