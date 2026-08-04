import { Icons } from "./icons.js";
import { Api } from "./api.js";
import { MicRecorder } from "./wav.js";

// ---------- util ----------

const $ = (sel, root) => (root || document).querySelector(sel);
const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function mountIcons(root) {
  $all("[data-icon]", root).forEach((el) => {
    const name = el.getAttribute("data-icon");
    if (Icons[name]) el.innerHTML = Icons[name];
  });
}

function formatBytes(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Menghubungkan klik-untuk-pilih dan drag-and-drop ke satu <input type=file>.
function initDropzone(zoneEl, inputEl, onFile) {
  zoneEl.addEventListener("click", () => inputEl.click());
  zoneEl.addEventListener("dragover", (e) => { e.preventDefault(); zoneEl.style.borderColor = "var(--teal)"; });
  zoneEl.addEventListener("dragleave", () => { zoneEl.style.borderColor = ""; });
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    zoneEl.style.borderColor = "";
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) onFile(file);
  });
  inputEl.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) onFile(file);
  });
}

function toast(message, isError) {
  const wrap = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3500);
}

// ---------- tema ----------

function initTheme() {
  const saved = localStorage.getItem("lais-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  $("#theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme")
      || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("lais-theme", next);
  });
}

// ---------- navigasi panel ----------

function initNav() {
  $all(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.panel));
  });
  $("#meter-cpu").addEventListener("click", () => showPanel("system"));
  $("#meter-ram").addEventListener("click", () => showPanel("system"));
  $("#meter-gpu").addEventListener("click", () => showPanel("system"));
}

function showPanel(name) {
  $all(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  $all(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  if (name === "system") refreshSystemPanel();
}

// ---------- meter bridge (CPU/RAM/GPU langsung dari mesin) ----------

const BAR_COUNT = 8;

function renderBars(container, pct) {
  if (container.children.length !== BAR_COUNT) {
    container.innerHTML = "";
    for (let i = 0; i < BAR_COUNT; i++) container.appendChild(document.createElement("i"));
  }
  const lit = Math.round((pct / 100) * BAR_COUNT);
  $all("i", container).forEach((bar, idx) => {
    const isLit = idx < lit;
    bar.classList.toggle("lit", isLit);
    bar.classList.toggle("hot", isLit && idx >= 5);
    bar.classList.toggle("crit", isLit && idx >= 7);
  });
}

let lastPerf = null;

async function pollPerf() {
  try {
    const p = await Api.perf();
    lastPerf = p;
    renderBars($("#bars-cpu"), p.cpuPercent);
    $("#val-cpu").textContent = `${Math.round(p.cpuPercent)}%`;

    const ramPct = p.ramTotalBytes ? (p.ramUsedBytes / p.ramTotalBytes) * 100 : 0;
    renderBars($("#bars-ram"), ramPct);
    $("#val-ram").textContent = `${Math.round(ramPct)}%`;

    const gpuMeter = $("#meter-gpu");
    if (p.gpu) {
      gpuMeter.style.display = "";
      renderBars($("#bars-gpu"), p.gpu.utilizationPercent);
      $("#val-gpu").textContent = `${Math.round(p.gpu.utilizationPercent)}%`;
    } else {
      gpuMeter.style.display = "none";
    }

    if ($("#panel-system").classList.contains("active")) renderSystemCards(p);
  } catch {
    // mesin baru start / belum bisa dihubungi — diamkan, coba lagi di tick berikutnya
  }
}

// ---------- status engine (dipakai nav dot + status-line tiap panel) ----------

const ENGINE_META = {
  llm: { navId: "nav-status-llm", statusId: "chat-status", label: "mesin chat" },
  img: { navId: "nav-status-img", statusId: "img-status", label: "mesin image gen" },
  stt: { navId: "nav-status-stt", statusId: "stt-status", label: "mesin STT" },
  tts: { navId: "nav-status-tts", statusId: "tts-status", label: "mesin TTS" },
};

const engineState = { llm: null, img: null, stt: null, tts: null };

async function pollEngineStatus(kind) {
  const meta = ENGINE_META[kind];
  try {
    const s = await Api.status(kind);
    engineState[kind] = s;
    const navDot = document.getElementById(meta.navId);
    if (navDot) navDot.className = "nav-status" + (s.mesinHidup ? " ready" : "");

    const line = document.getElementById(meta.statusId);
    if (line) {
      const dot = $(".dot", line);
      const label = $("span:last-child", line);
      dot.className = "dot" + (s.mesinHidup ? " ready" : "");
      label.textContent = s.mesinHidup
        ? `siap — ${s.model || "model aktif"}`
        : (s.model ? `${meta.label} sedang menyala…` : `${meta.label} mati — pilih model di tab Model`);
    }
  } catch {
    // aplikasi baru buka / offline sesaat
  }
}

function pollAllEngines() {
  Object.keys(ENGINE_META).forEach(pollEngineStatus);
}

// ---------- model select dropdown (dipakai chat/image/stt/tts) ----------

async function populateModelSelect(kind, selectEl, onChange) {
  try {
    const data = await Api.models(kind);
    selectEl.innerHTML = "";
    if (!data.models || data.models.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "Belum ada model — buka tab Model";
      selectEl.appendChild(opt);
      selectEl.disabled = true;
      return;
    }
    selectEl.disabled = false;
    data.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      if (m === data.active) opt.selected = true;
      selectEl.appendChild(opt);
    });
    if (onChange) {
      selectEl.onchange = async () => {
        try {
          await Api.select(kind, selectEl.value);
          toast(`Mengganti ke ${selectEl.value}…`);
        } catch (err) {
          toast(err.message, true);
        }
      };
    }
  } catch (err) {
    selectEl.innerHTML = "<option>gagal memuat model</option>";
  }
}

// =================================================================
// CHAT
// =================================================================

let chatMessages = [];
let chatAttachedImage = null; // {dataUrl, name}
let chatAbort = null;

function initChat() {
  populateModelSelect("llm", $("#chat-model-select"), true);

  const input = $("#chat-input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(200, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#chat-form").requestSubmit();
    }
  });

  $("#chat-attach-btn").addEventListener("click", () => $("#chat-attach-input").click());
  $("#chat-attach-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    chatAttachedImage = { dataUrl, name: file.name };
    $("#chat-attach-preview").src = dataUrl;
    $("#chat-attach-chip").style.display = "inline-flex";
  });
  $("#chat-attach-remove").addEventListener("click", () => {
    chatAttachedImage = null;
    $("#chat-attach-input").value = "";
    $("#chat-attach-chip").style.display = "none";
  });

  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendChat();
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderChat() {
  const body = $("#chat-body");
  const empty = $("#chat-empty");
  body.innerHTML = "";
  if (chatMessages.length === 0) {
    body.appendChild(empty);
    return;
  }
  chatMessages.forEach((m) => {
    const wrap = document.createElement("div");
    wrap.className = `msg msg-${m.role}`;
    let inner = `<div class="msg-role">${m.role === "user" ? "kamu" : "asisten"}</div>`;
    if (m.image) inner += `<img class="msg-img-attach" src="${m.image}" alt="lampiran">`;
    inner += `<div class="msg-bubble">${escapeHtml(m.content)}</div>`;
    wrap.innerHTML = inner;
    body.appendChild(wrap);
  });
  body.scrollTop = body.scrollHeight;
}

async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (!engineState.llm || !engineState.llm.mesinHidup) {
    toast("Mesin chat sedang mati — pilih model dulu di tab Model.", true);
    return;
  }

  const userMsg = { role: "user", content: text };
  let content = text;
  if (chatAttachedImage) {
    userMsg.image = chatAttachedImage.dataUrl;
    content = [
      { type: "text", text },
      { type: "image_url", image_url: { url: chatAttachedImage.dataUrl } },
    ];
  }
  chatMessages.push(userMsg);
  renderChat();

  input.value = "";
  input.style.height = "auto";
  const hadImage = !!chatAttachedImage;
  chatAttachedImage = null;
  $("#chat-attach-chip").style.display = "none";
  $("#chat-attach-input").value = "";

  const sendBtn = $("#chat-send");
  sendBtn.disabled = true;

  const apiMessages = chatMessages.map((m, i) => {
    if (i === chatMessages.length - 1 && hadImage) return { role: m.role, content };
    return { role: m.role, content: m.content };
  });

  const assistantMsg = { role: "assistant", content: "" };
  chatMessages.push(assistantMsg);
  renderChat();

  try {
    chatAbort = new AbortController();
    const res = await Api.chatStream({ messages: apiMessages, stream: true }, chatAbort.signal);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "permintaan gagal" }));
      throw new Error(err.error || "permintaan gagal");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const token = JSON.parse(payload).choices[0].delta.content;
          if (token) {
            assistantMsg.content += token;
            renderChat();
          }
        } catch { /* potongan JSON belum utuh */ }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      assistantMsg.content = assistantMsg.content || `(gagal: ${err.message})`;
      renderChat();
      toast(err.message, true);
    }
  } finally {
    sendBtn.disabled = false;
    chatAbort = null;
  }
}

// =================================================================
// IMAGE
// =================================================================

let imgMode = "generate";
let imgSourceFile = null;
let imgGenStart = 0;
let imgTimer = null;

function initImage() {
  populateModelSelect("img", $("#img-model-select"), true);

  $all("#img-mode-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      imgMode = btn.dataset.mode;
      $all("#img-mode-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
      $("#img-edit-source").style.display = imgMode === "edit" ? "" : "none";
    });
  });

  initDropzone($("#img-dropzone"), $("#img-file-input"), async (file) => {
    imgSourceFile = file;
    const dataUrl = await fileToDataUrl(file);
    $("#img-dropzone-preview").src = dataUrl;
    $("#img-dropzone-preview").style.display = "";
    $("#img-dropzone-text").textContent = file.name;
  });

  $("#img-generate-btn").addEventListener("click", runImageGen);
}

function startElapsedTimer(el) {
  imgGenStart = Date.now();
  imgTimer = setInterval(() => {
    el.textContent = `${((Date.now() - imgGenStart) / 1000).toFixed(1)}s`;
  }, 100);
}
function stopElapsedTimer() {
  if (imgTimer) clearInterval(imgTimer);
  imgTimer = null;
}

async function runImageGen() {
  if (!engineState.img || !engineState.img.mesinHidup) {
    toast("Mesin image gen sedang mati — pilih model dulu di tab Model.", true);
    return;
  }
  const prompt = $("#img-prompt").value.trim();
  if (!prompt) { toast("Isi prompt dulu.", true); return; }
  if (imgMode === "edit" && !imgSourceFile) { toast("Pilih gambar sumber dulu.", true); return; }

  const btn = $("#img-generate-btn");
  const result = $("#img-result");
  btn.disabled = true;
  result.style.display = "flex";
  result.innerHTML = `<div class="generating"><div class="spinner"></div><span>Membuat gambar… bisa beberapa menit di CPU</span><span class="elapsed" id="img-elapsed">0.0s</span></div>`;
  startElapsedTimer($("#img-elapsed"));

  try {
    const size = $("#img-size").value;
    let blob;
    if (imgMode === "generate") {
      blob = await Api.imgGenerate({ prompt, size });
    } else {
      const fd = new FormData();
      fd.append("prompt", prompt);
      fd.append("image", imgSourceFile);
      fd.append("size", size);
      blob = await Api.imgEdit(fd);
    }
    const url = URL.createObjectURL(blob);
    result.innerHTML = `
      <img src="${url}" alt="Hasil generasi">
      <div class="img-result-actions">
        <a class="btn btn-sm" href="${url}" download="generated.png">${Icons.download}<span>Unduh</span></a>
      </div>`;
  } catch (err) {
    result.innerHTML = `<div class="empty">${Icons.alert}<p>${escapeHtml(err.message)}</p></div>`;
    toast(err.message, true);
  } finally {
    stopElapsedTimer();
    btn.disabled = false;
  }
}

// =================================================================
// SPEECH TO TEXT
// =================================================================

let micRecorder = null;
let isRecording = false;

function initStt() {
  populateModelSelect("stt", $("#stt-model-select"), true);

  $("#mic-btn").addEventListener("click", toggleRecording);

  initDropzone($("#stt-dropzone"), $("#stt-file-input"), (file) => {
    $("#stt-dropzone-text").textContent = file.name;
    runTranscribe(file, file.name);
  });

  $("#stt-copy-btn").addEventListener("click", async () => {
    const ta = $("#stt-transcript");
    if (!ta.value) return;
    await navigator.clipboard.writeText(ta.value);
    toast("Transkrip disalin.");
  });

  const level = $("#level-meter");
  for (let i = 0; i < 24; i++) level.appendChild(document.createElement("i"));
}

async function toggleRecording() {
  if (!engineState.stt || !engineState.stt.mesinHidup) {
    toast("Mesin STT sedang mati — pilih model dulu di tab Model.", true);
    return;
  }
  const btn = $("#mic-btn");
  if (!isRecording) {
    try {
      micRecorder = new MicRecorder((level) => setLevel(level));
      await micRecorder.start();
      isRecording = true;
      btn.classList.add("recording");
      btn.innerHTML = Icons.stop;
    } catch (err) {
      toast("Tidak bisa mengakses mikrofon: " + err.message, true);
    }
  } else {
    const blob = micRecorder.stop();
    isRecording = false;
    btn.classList.remove("recording");
    btn.innerHTML = Icons.mic;
    setLevel(0);
    runTranscribe(blob, "rekaman.wav");
  }
}

function setLevel(v) {
  const bars = $all("#level-meter i");
  const lit = Math.round(v * bars.length);
  bars.forEach((bar, idx) => {
    const on = idx < lit;
    bar.style.height = on ? `${8 + (idx / bars.length) * 18}px` : "6px";
    bar.style.background = on ? (idx > bars.length * 0.8 ? "var(--red)" : "var(--teal)") : "var(--border-strong)";
  });
}

async function runTranscribe(blob, filename) {
  const ta = $("#stt-transcript");
  ta.value = "Mentranskripsi…";
  try {
    const res = await Api.transcribe(blob, filename);
    ta.value = res.text || "(tidak ada teks terdeteksi)";
  } catch (err) {
    ta.value = "";
    toast(err.message, true);
  }
}

// =================================================================
// TEXT TO SPEECH
// =================================================================

function initTts() {
  populateModelSelect("tts", $("#tts-model-select"), true);
  $("#tts-speak-btn").addEventListener("click", runSpeak);
}

async function runSpeak() {
  if (!engineState.tts || !engineState.tts.mesinHidup) {
    toast("Mesin TTS sedang mati — pilih model dulu di tab Model.", true);
    return;
  }
  const text = $("#tts-text").value.trim();
  if (!text) { toast("Isi teks dulu.", true); return; }

  const btn = $("#tts-speak-btn");
  const result = $("#tts-result");
  btn.disabled = true;
  try {
    const blob = await Api.speak(text, $("#tts-voice").value.trim());
    const url = URL.createObjectURL(blob);
    result.style.display = "flex";
    result.innerHTML = `
      <audio controls autoplay src="${url}"></audio>
      <a class="btn btn-sm" href="${url}" download="suara.wav">${Icons.download}<span>Unduh</span></a>`;
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// =================================================================
// MODELS (panel terpadu untuk 4 jenis mesin)
// =================================================================

const MODEL_KIND_LABEL = { llm: "chat", img: "image gen", stt: "STT", tts: "TTS" };
const MODEL_KIND_EXT = { llm: ".gguf", img: ".gguf/.safetensors", stt: ".bin", tts: ".gguf" };
let activeModelKind = "llm";
let progressTimer = null;

function initModels() {
  $all(".model-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeModelKind = btn.dataset.kind;
      $all(".model-tab").forEach((b) => b.classList.toggle("active", b === btn));
      renderModelsPanel();
    });
  });
}

async function renderModelsPanel() {
  const body = $("#models-body");
  body.innerHTML = `<div class="empty">${Icons.loader}<p>Memuat&hellip;</p></div>`;

  const kind = activeModelKind;
  try {
    const [installed, catalog] = await Promise.all([Api.models(kind), Api.catalog(kind)]);
    if (kind !== activeModelKind) return; // pengguna sudah pindah tab

    body.innerHTML = "";

    body.appendChild(sectionTitle("Terpasang"));
    if (!installed.models || installed.models.length === 0) {
      body.appendChild(emptyBlock(`Belum ada model ${MODEL_KIND_LABEL[kind]} terpasang.`));
    } else {
      installed.models.forEach((m) => {
        body.appendChild(installedRow(kind, m, m === installed.active));
      });
    }

    body.appendChild(sectionTitle("Tersedia untuk diunduh"));
    (catalog.models || []).forEach((m) => {
      body.appendChild(catalogRow(kind, m));
    });

    const customWrap = document.createElement("div");
    customWrap.style.marginTop = "18px";
    customWrap.innerHTML = `
      <label class="label">Atau tempel URL Hugging Face (${MODEL_KIND_EXT[kind]})</label>
      <div class="custom-url-row">
        <input class="field" id="custom-url-input" placeholder="https://huggingface.co/...">
        <button class="btn" id="custom-url-btn">${Icons.download}<span>Unduh</span></button>
      </div>`;
    body.appendChild(customWrap);
    $("#custom-url-btn", customWrap).addEventListener("click", () => {
      const url = $("#custom-url-input", customWrap).value.trim();
      if (!url) return;
      startDownload(kind, url);
    });

    mountIcons(body);
    startProgressPolling();
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(emptyBlock("Gagal memuat katalog: " + err.message));
  }
}

function sectionTitle(text) {
  const el = document.createElement("div");
  el.className = "model-section-title";
  el.textContent = text;
  return el;
}

function emptyBlock(text) {
  const el = document.createElement("div");
  el.className = "empty";
  el.style.padding = "24px";
  el.innerHTML = `${Icons.box}<p>${escapeHtml(text)}</p>`;
  return el;
}

function installedRow(kind, filename, isActive) {
  const row = document.createElement("div");
  row.className = "model-row";
  row.innerHTML = `
    <div class="model-row-main">
      <div class="model-row-file">${escapeHtml(filename)}</div>
    </div>
    ${isActive ? '<span class="badge active">Aktif</span>' : ""}
    <div class="model-row-actions">
      ${!isActive ? `<button class="btn btn-sm use-btn">Pakai</button>` : ""}
      <button class="btn btn-sm btn-icon btn-danger del-btn" aria-label="Hapus">${Icons.trash}</button>
    </div>`;
  const useBtn = $(".use-btn", row);
  if (useBtn) useBtn.addEventListener("click", async () => {
    try {
      await Api.select(kind, filename);
      toast(`Mengganti ke ${filename}…`);
      renderModelsPanel();
    } catch (err) { toast(err.message, true); }
  });
  $(".del-btn", row).addEventListener("click", async () => {
    if (!confirm(`Hapus ${filename}?`)) return;
    try {
      await Api.deleteModel(kind, filename);
      toast(`${filename} dihapus.`);
      renderModelsPanel();
    } catch (err) { toast(err.message, true); }
  });
  return row;
}

function catalogRow(kind, item) {
  const row = document.createElement("div");
  row.className = "model-row";
  row.dataset.file = item.file;
  const sizeTxt = formatBytes(item.sizeBytes) + (item.projectorSizeBytes ? ` + ${formatBytes(item.projectorSizeBytes)} proyektor` : "");
  row.innerHTML = `
    <div class="model-row-main">
      <div class="model-row-name">${escapeHtml(item.name)}</div>
      ${item.note ? `<div class="model-row-note">${escapeHtml(item.note)}</div>` : ""}
    </div>
    <div class="model-row-size">${sizeTxt}</div>
    <div class="model-row-actions">
      ${item.installed
        ? '<span class="badge">Terpasang</span>'
        : `<button class="btn btn-sm install-btn">${Icons.download}<span>Pasang</span></button>`}
    </div>`;
  const installBtn = $(".install-btn", row);
  if (installBtn) {
    installBtn.addEventListener("click", () => startDownload(kind, item.url, item.projectorUrl));
  }
  return row;
}

async function startDownload(kind, url, projectorUrl) {
  try {
    await Api.download(kind, url, projectorUrl);
    toast("Unduhan dimulai.");
    startProgressPolling();
  } catch (err) {
    toast(err.message, true);
  }
}

function startProgressPolling() {
  if (progressTimer) return;
  progressTimer = setInterval(async () => {
    try {
      const p = await Api.progress();
      renderProgress(p);
      if (p.done) {
        clearInterval(progressTimer);
        progressTimer = null;
        removeProgressBar();
        if (p.error) toast(p.error, true);
        else toast(`${p.label || "Unduhan"} selesai.`);
        renderModelsPanel();
      }
    } catch { /* diamkan */ }
  }, 500);
}

function removeProgressBar() {
  const existing = $("#dl-progress-wrap");
  if (existing) existing.remove();
}

function renderProgress(p) {
  if (!p.active) return;
  let wrap = $("#dl-progress-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "dl-progress-wrap";
    wrap.className = "download-bar-wrap";
    wrap.innerHTML = `
      <div class="download-bar"><i></i></div>
      <div class="download-status">
        <span id="dl-progress-label"></span>
        <span style="display:flex; gap:10px; align-items:center">
          <span id="dl-progress-pct"></span>
          <button class="btn btn-sm btn-ghost" id="dl-cancel-btn">Batal</button>
        </span>
      </div>`;
    const models = $("#models-body");
    models.insertBefore(wrap, models.firstChild.nextSibling ? models.children[1] : null);
    $("#dl-cancel-btn", wrap).addEventListener("click", async () => {
      await Api.cancelDownload(activeModelKind);
      toast("Unduhan dibatalkan.");
    });
  }
  $("i", wrap).style.width = `${p.percent || 0}%`;
  $("#dl-progress-label", wrap).textContent = p.label || "Mengunduh…";
  $("#dl-progress-pct", wrap).textContent = p.total
    ? `${formatBytes(p.downloaded)} / ${formatBytes(p.total)} (${p.percent}%)`
    : "";
}

// =================================================================
// SYSTEM
// =================================================================

function renderSystemCards(p) {
  const wrap = $("#system-cards");
  const ramPct = p.ramTotalBytes ? (p.ramUsedBytes / p.ramTotalBytes) * 100 : 0;
  let html = `
    <div class="card">
      <div class="card-label">${Icons.cpu}<span>CPU</span></div>
      <div class="card-value">${Math.round(p.cpuPercent)}<small>%</small></div>
      <div class="bar-track"><i style="width:${p.cpuPercent}%" class="${p.cpuPercent > 85 ? "crit" : p.cpuPercent > 60 ? "hot" : ""}"></i></div>
      <div class="card-sub">${p.cpuCores} core</div>
    </div>
    <div class="card">
      <div class="card-label">${Icons.sliders}<span>RAM</span></div>
      <div class="card-value">${Math.round(ramPct)}<small>%</small></div>
      <div class="bar-track"><i style="width:${ramPct}%" class="${ramPct > 85 ? "crit" : ramPct > 60 ? "hot" : ""}"></i></div>
      <div class="card-sub">${formatBytes(p.ramUsedBytes)} / ${formatBytes(p.ramTotalBytes)}</div>
    </div>`;
  if (p.gpu) {
    html += `
    <div class="card">
      <div class="card-label">${Icons.gpu}<span>GPU</span></div>
      <div class="card-value">${Math.round(p.gpu.utilizationPercent)}<small>%</small></div>
      <div class="bar-track"><i style="width:${p.gpu.utilizationPercent}%"></i></div>
      <div class="card-sub">${escapeHtml(p.gpu.name)} — ${formatBytes(p.gpu.vramUsedBytes)} / ${formatBytes(p.gpu.vramTotalBytes)} VRAM</div>
    </div>`;
  } else {
    html += `
    <div class="card">
      <div class="card-label">${Icons.gpu}<span>GPU</span></div>
      <div class="card-sub">Tidak ada GPU NVIDIA terdeteksi. Mesin berjalan di CPU.</div>
    </div>`;
  }
  wrap.innerHTML = html;
}

function renderEngineGrid() {
  const wrap = $("#engine-grid");
  const icons = { llm: "chat", img: "image", stt: "mic", tts: "waveform" };
  const names = { llm: "Chat", img: "Image Gen", stt: "Suara→Teks", tts: "Teks→Suara" };
  wrap.innerHTML = Object.keys(ENGINE_META).map((kind) => {
    const s = engineState[kind];
    const ready = s && s.mesinHidup;
    return `
      <div class="engine-card">
        <div class="engine-card-top">
          <div class="engine-name">${Icons[icons[kind]]}<span>${names[kind]}</span></div>
          <span class="status-line"><span class="dot${ready ? " ready" : ""}"></span></span>
        </div>
        <div class="engine-model">${s ? (s.model || (ready ? "aktif" : "tidak ada model")) : "—"}</div>
      </div>`;
  }).join("");
}

async function refreshSystemPanel() {
  if (lastPerf) renderSystemCards(lastPerf);
  renderEngineGrid();
  await Promise.all(Object.keys(ENGINE_META).map(pollEngineStatus));
  renderEngineGrid();
}

// =================================================================
// INIT
// =================================================================

function init() {
  mountIcons(document);
  initTheme();
  initNav();
  initChat();
  initImage();
  initStt();
  initTts();
  initModels();

  $("#system-refresh").addEventListener("click", refreshSystemPanel);

  pollPerf();
  pollAllEngines();
  setInterval(pollPerf, 2500);
  setInterval(pollAllEngines, 3000);

  renderModelsPanel();
}

document.addEventListener("DOMContentLoaded", init);
