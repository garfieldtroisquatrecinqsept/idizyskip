const DEFAULTS = { enabled: true, idizyOnly: true, names: [] };
const $ = id => document.getElementById(id);
const normalize = s => String(s).trim().toLowerCase().replace(/^@/, "");

let settings = { ...DEFAULTS };
let report = null;

function fmt(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await browser.storage.local.set(patch);
  render();
}

function addNames(raw) {
  const names = [...settings.names];
  for (const part of raw.split(/[\s,;]+/).map(normalize).filter(Boolean)) {
    if (!names.includes(part)) names.push(part);
  }
  return save({ names });
}

function removeName(name) {
  return save({ names: settings.names.filter(n => n !== name) });
}

function toggleName(name) {
  const key = normalize(name);
  return settings.names.includes(key) ? removeName(key) : addNames(key);
}

function renderList() {
  const list = $("list");
  list.replaceChildren();
  for (const name of settings.names) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = name;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.title = `Retirer ${name}`;
    del.addEventListener("click", () => removeName(name));
    li.append(label, del);
    list.appendChild(li);
  }
  $("empty").hidden = settings.names.length > 0;
}

function renderCurrent() {
  const section = $("current");
  if (!report || !report.onWatch) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const status = $("status");
  const box = $("streamers");
  box.replaceChildren();

  if (report.loading) {
    status.textContent = "Lecture des chapitres…";
    return;
  }
  if (!report.chapterCount) {
    status.textContent = "Pas de chapitres sur cette vidéo, rien à skip.";
    return;
  }
  if (settings.idizyOnly && !report.isIdizy) {
    status.textContent = `${report.owner || "Cette chaîne"} n'est pas Idizy : rien n'est skippé ici.`;
  } else {
    status.textContent = "Clique sur un streamer pour l'ajouter ou le retirer.";
  }

  const streamers = report.streamers.slice().sort((a, b) => b.count - a.count || b.seconds - a.seconds);
  for (const s of streamers) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    if (settings.names.includes(s.key)) chip.classList.add("blocked");
    const name = document.createElement("span");
    name.textContent = s.name;
    const meta = document.createElement("small");
    meta.textContent = s.count > 1 ? `×${s.count} · ${fmt(s.seconds)}` : fmt(s.seconds);
    chip.append(name, meta);
    chip.addEventListener("click", () => toggleName(s.name));
    box.appendChild(chip);
  }
}

function render() {
  $("enabled").checked = settings.enabled;
  $("idizyOnly").checked = settings.idizyOnly;
  document.body.classList.toggle("off", !settings.enabled);
  renderList();
  renderCurrent();
}

async function loadReport(attempt = 0) {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    report = tab ? await browser.tabs.sendMessage(tab.id, { type: "idz-info" }) : null;
  } catch {
    report = null;
  }
  render();
  if (report?.loading && attempt < 10) setTimeout(() => loadReport(attempt + 1), 700);
}

$("add").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("name");
  if (!input.value.trim()) return;
  addNames(input.value);
  input.value = "";
  input.focus();
});

$("enabled").addEventListener("change", e => save({ enabled: e.target.checked }));
$("idizyOnly").addEventListener("change", e => save({ idizyOnly: e.target.checked }));

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(changes)) {
    if (k in DEFAULTS) settings[k] = v.newValue ?? DEFAULTS[k];
  }
  render();
});

browser.storage.local.get(DEFAULTS).then(stored => {
  settings = { ...DEFAULTS, ...stored };
  render();
  loadReport();
  $("name").focus();
});
