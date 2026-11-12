(() => {
  "use strict";

  const LIMITS = window.QR_LIMITS || { max_w: 220, max_h: 250, json_budget: 16384 };
  const $ = (id) => document.getElementById(id);

  const els = {
    tabs: document.querySelectorAll("[data-source]"),
    sourceFile: $("source-file"),
    sourceUrl: $("source-url"),
    drop: $("drop"),
    dropTitle: $("drop-title"),
    dropSub: $("drop-sub"),
    fileInput: $("file-input"),
    urlInput: $("url-input"),
    urlLoad: $("url-load"),
    crop: {
      top: $("crop-top"), right: $("crop-right"),
      bottom: $("crop-bottom"), left: $("crop-left"),
    },
    compression: $("compression"),
    compressionOut: $("compression-out"),
    threshold: $("threshold"),
    thresholdOut: $("threshold-out"),
    modeButtons: document.querySelectorAll("[data-mode]"),
    invert: $("invert"),
    save: $("save-defaults"),
    sourceMeta: $("source-meta"),
    sourceEmpty: $("source-empty"),
    sourceStack: $("source-stack"),
    sourceImg: $("source-img"),
    shade: {
      top: $("shade-top"), right: $("shade-right"),
      bottom: $("shade-bottom"), left: $("shade-left"),
    },
    keep: $("keep"),
    resultMeta: $("result-meta"),
    resultImg: $("result-img"),
    slotEmpty: $("slot-empty"),
    fit: $("fit"),
    statSize: $("stat-size"),
    statBytes: $("stat-bytes"),
    statJson: $("stat-json"),
    budgetFill: $("budget-fill"),
    output: $("output-code"),
    copyBytes: $("copy-bytes"),
    copyC: $("copy-c"),
    downloadH: $("download-h"),
    status: $("server-status"),
    statusText: $("server-status-text"),
    toast: $("toast"),
  };

  const state = {
    source: null,        // { kind: "file", file } | { kind: "url", url }
    natural: null,       // { w, h } of the loaded source
    mode: [...els.modeButtons].find((b) => b.getAttribute("aria-checked") === "true")?.dataset.mode || "horizontal",
    result: null,
    seq: 0,
    controller: null,
    objectUrl: null,
  };

  /* ───────── helpers ───────── */
  let toastTimer;
  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle("error", isError);
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  const num = (el) => Math.max(0, parseInt(el.value, 10) || 0);
  const fmt = (n) => n.toLocaleString("en-IN");

  function currentSettings() {
    return {
      crop_top: num(els.crop.top),
      crop_right: num(els.crop.right),
      crop_bottom: num(els.crop.bottom),
      crop_left: num(els.crop.left),
      compression: parseInt(els.compression.value, 10),
      threshold: parseInt(els.threshold.value, 10),
      mode: state.mode,
      invert: els.invert.checked,
    };
  }

  /* ───────── source selection ───────── */
  function setTab(kind) {
    els.tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.source === kind)));
    els.sourceFile.hidden = kind !== "file";
    els.sourceUrl.hidden = kind !== "url";
  }
  els.tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.source)));

  function showSource(src, label) {
    state.source = src;
    state.natural = null;
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }

    if (src.kind === "file") {
      state.objectUrl = URL.createObjectURL(src.file);
      els.sourceImg.src = state.objectUrl;
    } else {
      els.sourceImg.src = src.url;
    }
    els.sourceMeta.textContent = label;
  }

  els.sourceImg.addEventListener("load", () => {
    state.natural = { w: els.sourceImg.naturalWidth, h: els.sourceImg.naturalHeight };
    els.sourceEmpty.hidden = true;
    els.sourceStack.hidden = false;
    els.sourceMeta.textContent = `${state.natural.w} × ${state.natural.h} px`;
    updateCropOverlay();
    convert();
  });
  els.sourceImg.addEventListener("error", () => {
    if (!state.source) return;
    state.natural = null;
    els.sourceStack.hidden = true;
    els.sourceEmpty.hidden = false;
    // A URL can fail to preview in the browser and still convert on the server, so try anyway.
    if (state.source.kind === "url") convert();
    else toast("That file couldn't be read as an image.", true);
  });

  function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Choose an image file (PNG or JPG).", true); return; }
    els.dropTitle.textContent = file.name;
    els.dropSub.textContent = `${(file.size / 1024).toFixed(1)} KB · click to replace`;
    showSource({ kind: "file", file }, "Loading…");
  }

  els.fileInput.addEventListener("change", () => handleFile(els.fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("over"); }));
  els.drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

  function loadUrl() {
    const url = els.urlInput.value.trim();
    if (!/^https?:\/\//i.test(url)) { toast("Enter a full URL starting with http:// or https://", true); return; }
    showSource({ kind: "url", url }, "Loading…");
  }
  els.urlLoad.addEventListener("click", loadUrl);
  els.urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadUrl(); } });

  /* ───────── crop overlay ───────── */
  function updateCropOverlay() {
    if (!state.natural) return;
    const { w, h } = state.natural;
    const s = currentSettings();
    const pct = (v, total) => `${Math.min(100, (v / total) * 100)}%`;
    const left = Math.min(s.crop_left, w), right = Math.min(s.crop_right, w - left);
    const top = Math.min(s.crop_top, h), bottom = Math.min(s.crop_bottom, h - top);

    Object.assign(els.shade.top.style,    { left: 0, top: 0, right: 0, height: pct(top, h) });
    Object.assign(els.shade.bottom.style, { left: 0, bottom: 0, right: 0, height: pct(bottom, h) });
    Object.assign(els.shade.left.style,   { left: 0, top: pct(top, h), bottom: pct(bottom, h), width: pct(left, w) });
    Object.assign(els.shade.right.style,  { right: 0, top: pct(top, h), bottom: pct(bottom, h), width: pct(right, w) });
    Object.assign(els.keep.style, {
      left: pct(left, w), top: pct(top, h), right: pct(right, w), bottom: pct(bottom, h),
    });
  }

  /* ───────── conversion ───────── */
  function setFit(kind, message) {
    els.fit.className = `fit ${kind}`;
    els.fit.textContent = message;
  }

  function clearResult(message) {
    state.result = null;
    els.resultImg.hidden = true;
    els.slotEmpty.hidden = false;
    els.slotEmpty.textContent = message || "Preview appears here";
    els.resultMeta.textContent = "—";
    els.statSize.textContent = els.statBytes.textContent = els.statJson.textContent = "—";
    els.budgetFill.style.width = "0";
    els.output.textContent = "Nothing converted yet.";
    [els.copyBytes, els.copyC, els.downloadH].forEach((b) => (b.disabled = true));
  }

  async function convert() {
    if (!state.source) return;

    state.controller?.abort();
    const controller = (state.controller = new AbortController());
    const seq = ++state.seq;

    const body = new FormData();
    if (state.source.kind === "file") body.append("image", state.source.file);
    else body.append("image_url", state.source.url);
    Object.entries(currentSettings()).forEach(([k, v]) => body.append(k, String(v)));
    body.append("preview", "1");

    document.body.classList.add("is-busy");
    try {
      const res = await fetch("/convert", { method: "POST", body, signal: controller.signal });
      const data = await res.json();
      if (seq !== state.seq) return;
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      renderResult(data);
    } catch (err) {
      if (err.name === "AbortError") return;
      clearResult("No preview");
      setFit("bad", err.message || "Conversion failed.");
    } finally {
      if (seq === state.seq) document.body.classList.remove("is-busy");
    }
  }
  const convertSoon = debounce(convert, 220);

  function renderResult(data) {
    state.result = data;

    els.resultImg.src = `data:image/png;base64,${data.preview_image}`;
    els.resultImg.width = data.width;
    els.resultImg.height = data.height;
    els.resultImg.hidden = false;
    els.slotEmpty.hidden = true;

    els.resultMeta.textContent = `${data.width} × ${data.height} px, shown 1:1`;
    els.statSize.textContent = `${data.width} × ${data.height}`;
    els.statBytes.textContent = fmt(data.byte_count);

    // Each byte is "0xFF, " = 6 chars; the ESP32 parses the response into a 16 KB JSON buffer.
    const used = data.json_bytes / LIMITS.json_budget;
    els.statJson.textContent = `${Math.round(used * 100)}%`;
    els.budgetFill.style.width = `${Math.min(100, used * 100)}%`;
    els.budgetFill.className = used > 1 ? "bad" : used > 0.8 ? "warn" : "";

    els.output.textContent = data.byte_array;
    [els.copyBytes, els.copyC, els.downloadH].forEach((b) => (b.disabled = false));

        const tooWide = data.width > LIMITS.max_w;
    const tooTall = data.height > LIMITS.max_h;

    const wasResized =
      data.width < data.original_width ||
      data.height < data.original_height;

    if (used > 1 || tooWide || tooTall) {
      setFit("bad", "The QR still exceeds the ESP32 limits. Please check the backend sizing settings.");
    } else if (used > 0.8) {
      setFit(
        "warn",
        `QR automatically fitted to ${data.width} × ${data.height} px, but buffer usage is ${Math.round(used * 100)}%. We should reserve more buffer space.`
      );
    } else if (wasResized) {
      setFit(
        "ok",
        `Automatically resized from ${data.original_width} × ${data.original_height} to ${data.width} × ${data.height} px. Fits the ESP32!`
      );
    } else if (data.width < 90) {
      setFit("warn", "Small QR. Test that your phone can still scan it from the counter.");
    } else {
      setFit("ok", "Fits the display and the ESP32 buffer.");
    }
  }

  /* ───────── control wiring ───────── */
  Object.values(els.crop).forEach((input) =>
    input.addEventListener("input", () => { updateCropOverlay(); convertSoon(); }));

  els.compression.addEventListener("input", () => {
    els.compressionOut.textContent = `${els.compression.value}%`;
    convertSoon();
  });
  els.threshold.addEventListener("input", () => {
    els.thresholdOut.textContent = els.threshold.value;
    convertSoon();
  });
  els.invert.addEventListener("change", convertSoon);

  els.modeButtons.forEach((btn) =>
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      els.modeButtons.forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
      convertSoon();
    }));

  /* ───────── save, copy, download ───────── */
  els.save.addEventListener("click", async () => {
    const s = currentSettings();
    els.save.disabled = true;
    try {
      const res = await fetch("/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crop: { top: s.crop_top, right: s.crop_right, bottom: s.crop_bottom, left: s.crop_left },
          compression: s.compression, threshold: s.threshold, mode: s.mode, invert: s.invert,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Server refused the settings.");
      toast("Saved. The ESP32 will use these settings on its next QR.");
    } catch (err) {
      toast(err.message || "Couldn't save the settings.", true);
    } finally {
      els.save.disabled = false;
    }
  });

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast(done);
  }

  function cArray() {
    const r = state.result;
    return [
      `// ${r.width} x ${r.height} px, ${r.byte_count} bytes, ${r.settings.mode === "vertical" ? "column" : "row"}-major, ${r.settings.invert ? "1 = dark" : "1 = light"}`,
      `#define QR_WIDTH  ${r.width}`,
      `#define QR_HEIGHT ${r.height}`,
      `const uint8_t qr_bitmap[] PROGMEM = {`,
      ...r.byte_array.match(/(?:0x[0-9A-F]{2}(?:, )?){1,12}/g).map((line) => `  ${line.trim().replace(/,?$/, ",")}`),
      `};`,
      ``,
    ].join("\n");
  }

  els.copyBytes.addEventListener("click", () => state.result && copy(state.result.byte_array, "Bytes copied."));
  els.copyC.addEventListener("click", () => state.result && copy(cArray(), "C array copied."));
  els.downloadH.addEventListener("click", () => {
    if (!state.result) return;
    const url = URL.createObjectURL(new Blob([cArray()], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "qr_bitmap.h" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Downloaded qr_bitmap.h");
  });

  /* ───────── server heartbeat ───────── */
  async function ping() {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (!res.ok) throw new Error();
      els.status.classList.remove("offline");
      els.statusText.textContent = "Server running";
    } catch {
      els.status.classList.add("offline");
      els.statusText.textContent = "Server not reachable";
    }
  }
  ping();
  setInterval(ping, 10000);

  clearResult();
})();
