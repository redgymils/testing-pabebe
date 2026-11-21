const stage = document.getElementById("stage");
const load = document.getElementById("load");
const activeTitle = document.getElementById("active-channel-title");
const episodesBox = document.getElementById("episodes");
const epCountBadge = document.getElementById("ep-count-badge");

// Toolbar controls
const searchToggleBtn = document.getElementById("search-toggle-btn");
const searchBarWrap = document.getElementById("search-bar-wrap");
const epSearchInput = document.getElementById("ep-search");
const searchClearBtn = document.getElementById("search-clear");
const sortBtn = document.getElementById("sort-btn");
const viewToggleBtn = document.getElementById("view-toggle-btn");

// macOS Traffic Light Buttons
const tlClose = document.getElementById("tl-close");
const tlSort = document.getElementById("tl-sort");
const tlFs = document.getElementById("tl-fs");

const PROGRESS_KEY = "pbb_ep_progress_v1";
const LAST_EP_KEY = "pbb_last_video_id_v1";
const CACHE_KEY = "pbb_yt_playlist_cache_v1_" + (YOUTUBE_CONFIG?.playlistId || "");

let episodes = [];
let currentVideoId = null;
let ytPlayer = null;
let ytReady = false;
let pendingVideo = null;
let progressTimer = null;
let sortDesc = false; // false = Episode 1 first, true = Latest first
let isGridView = false;
let searchQuery = "";

// === HELPERS ===
function setLoad(on, title, sub) {
  if (on) {
    if (title) load.querySelector(".t").textContent = title;
    if (sub) load.querySelector(".s").textContent = sub;
    load.classList.add("show");
  } else {
    load.classList.remove("show");
  }
}

function getProgressMap() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveProgress(videoId, currentTime, duration) {
  if (!videoId || !duration || duration < 10) return;
  const map = getProgressMap();
  // Clear resume marker if user finished > 96% of the episode
  if (currentTime / duration > 0.96) {
    delete map[videoId];
  } else if (currentTime >= 5) {
    map[videoId] = { time: Math.floor(currentTime), duration: Math.floor(duration) };
  }
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {}
}

function formatResumeTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function parseISODurationToSeconds(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0, 10) * 3600)
       + (parseInt(match[2] || 0, 10) * 60)
       + parseInt(match[3] || 0, 10);
}

function formatMinutesLabel(seconds) {
  if (!seconds) return "";
  const mins = Math.max(1, Math.round(seconds / 60));
  return `${mins} min`;
}

function formatAirDate(isoDate, title) {
  // Prefer date written in PBB title (e.g., "October 24, 2026")
  const titleDateMatch = title.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
  const parsed = new Date(titleDateMatch ? titleDateMatch[0] : isoDate);
  if (isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function extractEpisodeNumber(title, fallbackIndex) {
  const dayMatch = title.match(/\bDay\s+(\d+)\b/i) || title.match(/\bEpisode\s+(\d+)\b/i);
  return dayMatch ? parseInt(dayMatch[1], 10) : fallbackIndex + 1;
}

function escapeHTML(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&", "<": "<", ">": ">", '"': """, "'": "'"
  }[m]));
}

// === YOUTUBE DATA API v3 AUTO-FETCHER ===
async function fetchPlaylistEpisodes(forceRefresh = false) {
  const { apiKey, playlistId, cacheMinutes = 15 } = YOUTUBE_CONFIG || {};

  if (!apiKey || apiKey === "PASTE_YOUR_YOUTUBE_API_KEY_HERE") {
    setLoad(false);
    episodesBox.innerHTML = `
      <div class="empty-state">
        <strong>YouTube API Key Needed</strong><br>
        Open <code>data.js</code> and paste your YouTube Data API v3 key to automatically load all episodes.
      </div>`;
    return;
  }

  // Check browser cache first
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && (Date.now() - cached.savedAt) < cacheMinutes * 60 * 1000 && Array.isArray(cached.items) && cached.items.length) {
        episodes = cached.items;
        onEpisodesLoaded();
        return;
      }
    } catch {}
  }

  setLoad(true, "Loading Episodes", "Fetching latest playlist from YouTube...");

  try {
    // 1. Fetch all playlist items (handles pagination automatically)
    const rawItems = [];
    let nextPageToken = "";

    do {
      const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      url.searchParams.set("part", "snippet,contentDetails");
      url.searchParams.set("playlistId", playlistId);
      url.searchParams.set("maxResults", "50");
      url.searchParams.set("key", apiKey);
      if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || "Failed to load playlist");

      (data.items || []).forEach((item) => {
        const title = item?.snippet?.title || "";
        const videoId = item?.contentDetails?.videoId;
        if (!videoId || title === "Private video" || title === "Deleted video") return;
        rawItems.push({
          videoId,
          title,
          description: item.snippet.description || "",
          publishedAt: item.contentDetails.videoPublishedAt || item.snippet.publishedAt || "",
          thumb: item.snippet.thumbnails?.medium?.url
              || item.snippet.thumbnails?.high?.url
              || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
        });
      });

      nextPageToken = data.nextPageToken || "";
    } while (nextPageToken);

    // 2. Fetch exact video durations in batches of 50
    const durationMap = {};
    for (let i = 0; i < rawItems.length; i += 50) {
      const batchIds = rawItems.slice(i, i + 50).map((v) => v.videoId).join(",");
      const vUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      vUrl.searchParams.set("part", "contentDetails");
      vUrl.searchParams.set("id", batchIds);
      vUrl.searchParams.set("key", apiKey);

      const vRes = await fetch(vUrl.toString());
      const vData = await vRes.json();
      if (vRes.ok && vData.items) {
        vData.items.forEach((v) => {
          durationMap[v.id] = parseISODurationToSeconds(v?.contentDetails?.duration);
        });
      }
    }

    episodes = rawItems.map((item, idx) => {
      const durationSec = durationMap[item.videoId] || 0;
      return {
        ...item,
        epNum: extractEpisodeNumber(item.title, idx),
        durationSec,
        durationLabel: formatMinutesLabel(durationSec),
        dateLabel: formatAirDate(item.publishedAt, item.title)
      };
    });

    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items: episodes }));
    } catch {}

    onEpisodesLoaded();
  } catch (err) {
    setLoad(false);
    episodesBox.innerHTML = `
      <div class="empty-state">
        <strong>Could not load episodes</strong><br>
        ${escapeHTML(err.message)}
      </div>`;
  }
}

function onEpisodesLoaded() {
  epCountBadge.textContent = episodes.length;
  renderEpisodes();

  if (!episodes.length) {
    setLoad(false);
    episodesBox.innerHTML = `<div class="empty-state">No episodes found in this playlist yet.</div>`;
    return;
  }

  // Resume last watched episode or start with Episode 1
  const lastId = localStorage.getItem(LAST_EP_KEY);
  const initialEp = episodes.find((e) => e.videoId === lastId) || episodes[0];
  playEpisode(initialEp.videoId, false);
}

// === RENDER EPISODES ===
function renderEpisodes() {
  const progressMap = getProgressMap();
  const q = searchQuery.trim().toLowerCase();

  let list = episodes.filter((ep) => {
    if (!q) return true;
    return ep.title.toLowerCase().includes(q)
        || (`episode ${ep.epNum}`).includes(q)
        || ep.dateLabel.toLowerCase().includes(q);
  });

  if (sortDesc) list = [...list].reverse();

  episodesBox.classList.toggle("grid-mode", isGridView);
  episodesBox.innerHTML = "";

  if (!list.length) {
    episodesBox.innerHTML = `<div class="empty-state">No episodes match "${escapeHTML(searchQuery)}".</div>`;
    return;
  }

  list.forEach((ep) => {
    const isActive = ep.videoId === currentVideoId;
    const prog = progressMap[ep.videoId];
    const pct = prog && prog.duration ? Math.min(100, Math.round((prog.time / prog.duration) * 100)) : 0;
    const metaText = [ep.durationLabel, ep.dateLabel].filter(Boolean).join(" • ");

    const card = document.createElement("div");
    card.className = "ep-card" + (isActive ? " on" : "");
    card.dataset.id = ep.videoId;

    card.innerHTML = `
      <div class="ep-main">
        <div class="ep-thumb-wrap">
          <img class="ep-thumb" src="${escapeHTML(ep.thumb)}" alt="Episode ${ep.epNum}" loading="lazy">
          <div class="ep-play-overlay">
            <div class="ep-play-circle">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          ${pct > 0 ? `<div class="ep-progress-track"><div class="ep-progress-fill" style="width:${pct}%"></div></div>` : ""}
        </div>

        <div class="ep-info">
          <div class="ep-top-row">
            <span class="ep-num">Episode ${ep.epNum}</span>
            ${isActive ? `<span class="ep-playing-badge">PLAYING</span>` : ""}
          </div>
          <div class="ep-title">${escapeHTML(ep.title)}</div>
          <div class="ep-meta">${escapeHTML(metaText)}</div>
          ${prog ? `<div class="ep-resume">Resume at ${formatResumeTime(prog.time)}</div>` : ""}
        </div>

        <button class="ep-chevron" title="Episode Details" aria-label="Episode Details">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
      </div>

      <div class="ep-drawer">
        <div class="ep-desc">${escapeHTML(ep.description || "Pinoy Big Brother Collab Edition 3.0 Full Episode.")}</div>
        <div class="ep-actions">
          <button class="ep-action-btn restart-btn">Restart from 0:00</button>
          <a class="ep-action-btn" href="https://www.youtube.com/watch?v=${encodeURIComponent(ep.videoId)}" target="_blank" rel="noopener">Watch on YouTube</a>
        </div>
      </div>
    `;

    card.querySelector(".ep-main").addEventListener("click", (e) => {
      if (e.target.closest(".ep-chevron")) {
        card.classList.toggle("expanded");
        return;
      }
      playEpisode(ep.videoId, true);
    });

    card.querySelector(".restart-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const map = getProgressMap();
      delete map[ep.videoId];
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
      playEpisode(ep.videoId, true, 0);
    });

    episodesBox.appendChild(card);
  });
}

function updateActiveCardUI() {
  const progressMap = getProgressMap();
  document.querySelectorAll(".ep-card").forEach((card) => {
    const id = card.dataset.id;
    const isActive = id === currentVideoId;
    card.classList.toggle("on", isActive);

    const topRow = card.querySelector(".ep-top-row");
    const existingBadge = topRow.querySelector(".ep-playing-badge");
    if (isActive && !existingBadge) {
      topRow.insertAdjacentHTML("beforeend", `<span class="ep-playing-badge">PLAYING</span>`);
    } else if (!isActive && existingBadge) {
      existingBadge.remove();
    }

    // Refresh resume label & bar
    const prog = progressMap[id];
    const info = card.querySelector(".ep-info");
    let resumeEl = info.querySelector(".ep-resume");
    if (prog) {
      const txt = `Resume at ${formatResumeTime(prog.time)}`;
      if (!resumeEl) {
        resumeEl = document.createElement("div");
        resumeEl.className = "ep-resume";
        info.appendChild(resumeEl);
      }
      resumeEl.textContent = txt;
    } else if (resumeEl) {
      resumeEl.remove();
    }
  });
}

// === YOUTUBE IFRAME PLAYER API ===
(function loadYouTubeAPI() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
})();

window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  if (pendingVideo) {
    const { videoId, autoplay, startSec } = pendingVideo;
    pendingVideo = null;
    mountOrLoadPlayer(videoId, autoplay, startSec);
  }
};

function playEpisode(videoId, autoplay = true, overrideStart = null) {
  const ep = episodes.find((e) => e.videoId === videoId);
  if (!ep) return;

  currentVideoId = videoId;
  localStorage.setItem(LAST_EP_KEY, videoId);
  if (activeTitle) activeTitle.textContent = `Episode ${ep.epNum} — ${ep.dateLabel || "Full Episode"}`;
  updateActiveCardUI();

  const saved = getProgressMap()[videoId];
  const startSec = overrideStart !== null ? overrideStart : (saved ? saved.time : 0);

  if (!ytReady) {
    pendingVideo = { videoId, autoplay, startSec };
    return;
  }
  mountOrLoadPlayer(videoId, autoplay, startSec);
}

function mountOrLoadPlayer(videoId, autoplay, startSec) {
  if (!ytPlayer) {
    ytPlayer = new YT.Player("yt-player", {
      videoId,
      playerVars: {
        autoplay: autoplay ? 1 : 0,
        start: startSec,
        rel: 0,
        modestbranding: 1,
        playsinline: 1
      },
      events: {
        onReady: () => {
          setLoad(false);
          startProgressTracker();
        },
        onStateChange: onPlayerStateChange
      }
    });
  } else {
    setLoad(false);
    if (autoplay) {
      ytPlayer.loadVideoById({ videoId, startSeconds: startSec });
    } else {
      ytPlayer.cueVideoById({ videoId, startSeconds: startSec });
    }
  }
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
    recordCurrentTime();
    updateActiveCardUI();
  }
  // Auto-play next episode when current finishes
  if (event.data === YT.PlayerState.ENDED) {
    const idx = episodes.findIndex((e) => e.videoId === currentVideoId);
    if (idx !== -1 && idx + 1 < episodes.length) {
      playEpisode(episodes[idx + 1].videoId, true, 0);
    }
  }
}

function recordCurrentTime() {
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function" || !currentVideoId) return;
  const t = ytPlayer.getCurrentTime();
  const d = ytPlayer.getDuration();
  saveProgress(currentVideoId, t, d);
}

function startProgressTracker() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (ytPlayer && typeof ytPlayer.getPlayerState === "function" && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
      recordCurrentTime();
    }
  }, 3000);
}

window.addEventListener("beforeunload", recordCurrentTime);

// === TOOLBAR & WINDOW CONTROLS ===
searchToggleBtn.onclick = () => {
  const isHidden = searchBarWrap.classList.toggle("hidden");
  searchToggleBtn.classList.toggle("active", !isHidden);
  if (!isHidden) epSearchInput.focus();
  else {
    epSearchInput.value = "";
    searchQuery = "";
    renderEpisodes();
  }
};

epSearchInput.addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderEpisodes();
});

searchClearBtn.onclick = () => {
  epSearchInput.value = "";
  searchQuery = "";
  renderEpisodes();
  epSearchInput.focus();
};

function toggleSort() {
  sortDesc = !sortDesc;
  sortBtn.classList.toggle("active", sortDesc);
  sortBtn.title = sortDesc ? "Showing Latest First" : "Showing Episode 1 First";
  renderEpisodes();
}
sortBtn.onclick = toggleSort;
if (tlSort) tlSort.onclick = toggleSort;

viewToggleBtn.onclick = () => {
  isGridView = !isGridView;
  viewToggleBtn.classList.toggle("active", isGridView);
  renderEpisodes();
};

if (tlClose) {
  tlClose.onclick = () => fetchPlaylistEpisodes(true);
}

if (tlFs) {
  tlFs.onclick = () => {
    if (!document.fullscreenElement) {
      (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  };
}

// === SPLASH SCREEN & SUPPORT MODAL ===
window.addEventListener("load", function () {
  fetchPlaylistEpisodes(false);

  const splash = document.getElementById("splash-screen");
  const loadingUI = document.getElementById("splash-loading-ui");
  const enterBtn = document.getElementById("splash-enter-btn");
  const appWindow = document.getElementById("wrap");

  setTimeout(() => {
    if (loadingUI && enterBtn) {
      loadingUI.style.opacity = "0";
      loadingUI.style.transform = "translateY(-15px)";
      loadingUI.style.pointerEvents = "none";
      setTimeout(() => {
        loadingUI.style.display = "none";
        enterBtn.classList.add("show");
      }, 400);
    }
  }, 2200);

  if (enterBtn) {
    enterBtn.addEventListener("click", () => {
      splash.classList.add("hidden");
      if (appWindow) setTimeout(() => appWindow.classList.add("app-loaded"), 100);
      setTimeout(() => splash.remove(), 900);
    });
  }

  const donateBtn = document.getElementById("donate-btn");
  const supportModal = document.getElementById("support-modal");
  const closeSupport = document.getElementById("close-support");

  if (donateBtn && supportModal && closeSupport) {
    donateBtn.onclick = () => supportModal.classList.remove("hidden");
    closeSupport.onclick = () => supportModal.classList.add("hidden");
    supportModal.addEventListener("click", (e) => {
      if (e.target === supportModal) supportModal.classList.add("hidden");
    });
  }
});

// Copy Button Logic
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", function () {
    const targetId = this.getAttribute("data-target");
    const textToCopy = document.getElementById(targetId).innerText;
    navigator.clipboard.writeText(textToCopy).then(() => {
      const originalHTML = this.innerHTML;
      this.classList.add("copied");
      this.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      setTimeout(() => {
        this.classList.remove("copied");
        this.innerHTML = originalHTML;
      }, 2000);
    });
  });
});

// === LIVE VIEWER COUNTER (FIREBASE REALTIME DATABASE) ===
(function initLiveCounter() {
  if (typeof firebase === "undefined") return;

  const firebaseConfig = {
    apiKey: "AIzaSyBKOVwTWF5Dw1CH3cjpKlwzEFbolyzLEzI",
    authDomain: "pbb-live-counter.firebaseapp.com",
    databaseURL: "https://pbb-live-counter-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "pbb-live-counter",
    storageBucket: "pbb-live-counter.firebasestorage.app",
    messagingSenderId: "610176350304",
    appId: "1:610176350304:web:b4e3bb3536066d9037eb05"
  };

  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  const db = firebase.database();
  const viewerCountEl = document.getElementById("viewer-count");
  const sessionId = "v_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  const myViewerRef = db.ref("viewers/" + sessionId);
  const allViewersRef = db.ref("viewers");
  const connectedRef = db.ref(".info/connected");

  connectedRef.on("value", (snap) => {
    if (snap.val() === true) {
      myViewerRef.onDisconnect().remove();
      myViewerRef.set(true);
    }
  });

  allViewersRef.on("value", (snap) => {
    if (viewerCountEl) {
      viewerCountEl.textContent = snap.numChildren() || 1;
    }
  });
})();
