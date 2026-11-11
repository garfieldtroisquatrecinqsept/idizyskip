(() => {
  const api = globalThis.browser;
  const IDIZY_CHANNEL_ID = "UCo5DUue77cRJFSrnpzPA-Xg";
  const DEFAULTS = { enabled: true, idizyOnly: true, names: [] };
  const BACKUP_KEY = "idizySkip.settings";

  const state = {
    settings: { ...DEFAULTS },
    videoId: null,
    info: null,
    loading: false,
    segments: [],
    allowed: new Set(),
    token: 0,
    toastTimer: null,
    markerSig: ""
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const normalize = s => String(s).trim().toLowerCase().replace(/^@/, "");

  function decode(raw) {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw;
    }
  }

  function parseClock(text) {
    const parts = String(text).trim().split(":").map(Number);
    if (!parts.length || parts.some(n => Number.isNaN(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  function titleMatches(title, names) {
    const full = normalize(title);
    const words = full.split(/[^a-z0-9_]+/).filter(Boolean);
    return names.find(n => n === full || words.includes(n)) || null;
  }

  function makeInfo(chapters, owner, channelId, length) {
    const sorted = chapters.slice().sort((a, b) => a.start - b.start);
    return {
      chapters: sorted,
      owner,
      channelId,
      length,
      isIdizy: channelId === IDIZY_CHANNEL_ID || /idizy/i.test(owner)
    };
  }

  function parseWatchHtml(html) {
    const re = /"chapterRenderer":\{"title":\{"simpleText":"((?:[^"\\]|\\.)*)"\},"timeRangeStartMillis":(\d+)/g;
    const seen = new Map();
    let m;
    while ((m = re.exec(html))) {
      const start = Number(m[2]) / 1000;
      if (!seen.has(start)) seen.set(start, decode(m[1]));
    }
    const chapters = [...seen].map(([start, title]) => ({ start, title }));
    const owner = html.match(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/);
    const channelId = html.match(/"externalChannelId":"([^"]+)"/);
    const length = html.match(/"lengthSeconds":"(\d+)"/);
    return makeInfo(
      chapters,
      owner ? decode(owner[1]) : "",
      channelId ? channelId[1] : "",
      length ? Number(length[1]) : 0
    );
  }

  async function fetchInfo(id) {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, {
      credentials: "include"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseWatchHtml(await res.text());
  }

  function infoFromDom(id) {
    const flexy = document.querySelector("ytd-watch-flexy");
    if (!flexy || flexy.getAttribute("video-id") !== id) return null;
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"]'
    );
    if (!panel) return null;
    const chapters = [];
    for (const item of panel.querySelectorAll("ytd-macro-markers-list-item-renderer")) {
      const title = item.querySelector("h4")?.textContent?.trim();
      const start = parseClock(item.querySelector("#time")?.textContent ?? "");
      if (title && start !== null) chapters.push({ start, title });
    }
    if (!chapters.length) return null;
    const ownerEl = document.querySelector("ytd-watch-metadata #owner #channel-name a, ytd-video-owner-renderer #channel-name a");
    const owner = ownerEl?.textContent?.trim() ?? "";
    const href = ownerEl?.getAttribute("href") ?? "";
    const channelId = href.startsWith("/channel/") ? href.slice(9) : "";
    const video = getVideo();
    const length = video && Number.isFinite(video.duration) ? video.duration : 0;
    return makeInfo(chapters, owner, channelId, length);
  }

  const getPlayer = () => document.querySelector("#movie_player");
  const getVideo = () => document.querySelector("#movie_player video.html5-main-video, #movie_player video");

  function currentWatchId() {
    if (location.pathname !== "/watch") return null;
    return new URLSearchParams(location.search).get("v");
  }

  function getDuration() {
    const video = getVideo();
    if (video && Number.isFinite(video.duration) && video.duration > 0 && videoMatchesInfo(video)) {
      return video.duration;
    }
    return state.info?.length || 0;
  }

  function videoMatchesInfo(video) {
    const len = state.info?.length;
    if (!len || !Number.isFinite(video.duration)) return true;
    return Math.abs(video.duration - len) <= 3;
  }

  function applies() {
    const info = state.info;
    if (!state.settings.enabled || !info || !info.chapters.length) return false;
    return !state.settings.idizyOnly || info.isIdizy;
  }

  function rebuild() {
    state.segments = [];
    if (applies()) {
      const names = state.settings.names.map(normalize).filter(Boolean);
      const chapters = state.info.chapters;
      const dur = getDuration();
      chapters.forEach((ch, i) => {
        if (!titleMatches(ch.title, names)) return;
        const end = i + 1 < chapters.length ? chapters[i + 1].start : dur;
        if (!end || end <= ch.start) return;
        const last = state.segments[state.segments.length - 1];
        if (last && Math.abs(last.end - ch.start) < 0.5) {
          last.end = end;
          if (!last.titles.includes(ch.title)) last.titles.push(ch.title);
        } else {
          state.segments.push({ start: ch.start, end, titles: [ch.title], key: String(ch.start) });
        }
      });
    }
    renderMarkers(true);
  }

  async function load(id) {
    const token = ++state.token;
    state.videoId = id;
    state.info = null;
    state.loading = true;
    state.allowed = new Set();
    state.segments = [];
    hideToast();
    renderMarkers(true);

    let info = null;
    try {
      info = await fetchInfo(id);
    } catch (err) {
      console.debug("[Idizy Skip] fetch des chapitres impossible", err);
    }
    for (let i = 0; i < 6 && token === state.token && (!info || !info.chapters.length); i++) {
      await sleep(1500);
      info = infoFromDom(id) || info;
    }
    if (token !== state.token) return;
    state.info = info || makeInfo([], "", "", 0);
    state.loading = false;
    rebuild();
  }

  function check(video) {
    if (!state.segments.length || !state.settings.enabled) return;
    if (video !== getVideo()) return;
    const watchId = currentWatchId();
    if (watchId && watchId !== state.videoId) return;
    const player = getPlayer();
    if (!player || player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) return;
    if (!videoMatchesInfo(video)) return;
    const t = video.currentTime;
    const seg = state.segments.find(s => !state.allowed.has(s.key) && t >= s.start - 0.1 && t < s.end - 0.25);
    if (!seg) return;
    const dur = video.duration;
    video.currentTime = Number.isFinite(dur) ? Math.min(seg.end, dur) : seg.end;
    showToast(seg);
  }

  function uniqueTitles(titles) {
    const seen = new Set();
    return titles.filter(t => {
      const k = normalize(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function showToast(seg) {
    const player = getPlayer();
    if (!player) return;
    let el = player.querySelector(".idz-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "idz-toast";
      for (const type of ["click", "mousedown", "pointerdown", "dblclick"]) {
        el.addEventListener(type, e => e.stopPropagation());
      }
      player.appendChild(el);
    }
    const label = document.createElement("span");
    label.append("Clip de ");
    const who = document.createElement("strong");
    who.textContent = uniqueTitles(seg.titles).join(", ");
    label.append(who, " passé");
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Revenir";
    back.addEventListener("click", () => {
      state.allowed.add(seg.key);
      const video = getVideo();
      if (video) video.currentTime = seg.start;
      hideToast();
    });
    el.replaceChildren(label, back);
    el.classList.add("idz-show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    clearTimeout(state.toastTimer);
    document.querySelectorAll(".idz-toast").forEach(el => el.classList.remove("idz-show"));
  }

  function renderMarkers(force) {
    const bar = document.querySelector("#movie_player .ytp-progress-bar");
    const dur = getDuration();
    const sig = `${state.videoId}|${dur}|${state.segments.map(s => `${s.start}-${s.end}`).join(",")}`;
    const existing = bar?.querySelector(".idz-markers");
    if (!force && existing && sig === state.markerSig) return;
    document.querySelectorAll(".idz-markers").forEach(el => el.remove());
    state.markerSig = sig;
    if (!bar || !dur || !state.segments.length) return;
    const box = document.createElement("div");
    box.className = "idz-markers";
    for (const s of state.segments) {
      const m = document.createElement("div");
      m.className = "idz-marker";
      m.style.left = `${(s.start / dur) * 100}%`;
      m.style.width = `${((Math.min(s.end, dur) - s.start) / dur) * 100}%`;
      box.appendChild(m);
    }
    bar.appendChild(box);
  }

  function buildReport() {
    const info = state.info;
    const groups = new Map();
    if (info) {
      const dur = getDuration();
      info.chapters.forEach((ch, i) => {
        const end = i + 1 < info.chapters.length ? info.chapters[i + 1].start : dur;
        const key = normalize(ch.title);
        const g = groups.get(key) || { name: ch.title, key, count: 0, seconds: 0 };
        g.count += 1;
        g.seconds += Math.max(0, (end || ch.start) - ch.start);
        groups.set(key, g);
      });
    }
    return {
      videoId: state.videoId,
      onWatch: Boolean(currentWatchId()),
      loading: state.loading,
      owner: info?.owner ?? "",
      isIdizy: Boolean(info?.isIdizy),
      chapterCount: info?.chapters.length ?? 0,
      skippedSegments: state.segments.length,
      streamers: [...groups.values()]
    };
  }

  function onNavigate() {
    const id = currentWatchId();
    if (id && id !== state.videoId) load(id);
  }

  document.addEventListener("timeupdate", e => {
    if (e.target instanceof HTMLVideoElement) check(e.target);
  }, true);
  document.addEventListener("seeked", e => {
    if (e.target instanceof HTMLVideoElement) check(e.target);
  }, true);
  document.addEventListener("loadedmetadata", e => {
    if (e.target instanceof HTMLVideoElement) rebuild();
  }, true);
  document.addEventListener("yt-navigate-finish", onNavigate);

  setInterval(() => {
    onNavigate();
    renderMarkers(false);
  }, 1000);

  api.runtime.onMessage.addListener(msg => {
    if (msg?.type === "idz-info") return Promise.resolve(buildReport());
    return undefined;
  });

  function sanitize(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    if (typeof raw.idizyOnly === "boolean") out.idizyOnly = raw.idizyOnly;
    if (Array.isArray(raw.names)) out.names = raw.names.map(normalize).filter(Boolean);
    return out;
  }

  function readBackup() {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      return raw ? sanitize(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function writeBackup() {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(state.settings));
    } catch {}
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [k, v] of Object.entries(changes)) {
      if (k in DEFAULTS) state.settings[k] = v.newValue ?? DEFAULTS[k];
    }
    writeBackup();
    rebuild();
  });

  api.storage.local.get(null).then(async stored => {
    const backup = readBackup();
    if (!("names" in stored) && backup?.names) {
      stored = { ...DEFAULTS, ...backup };
      await api.storage.local.set(stored);
    }
    state.settings = { ...DEFAULTS, ...sanitize(stored) };
    writeBackup();
    rebuild();
    onNavigate();
  });
})();
