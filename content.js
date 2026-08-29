/* ChatGPT Bulk Image Generator — content script
 *
 * Injects a floating panel on chatgpt.com. Paste prompts (one per line);
 * the panel numbers them, then on Start it submits each prompt, waits for the
 * generated image to finish, and downloads it as 01.png, 02.png, ...
 *
 * Everything ChatGPT-DOM-specific lives in SELECTORS + the small set of
 * functions below (setPromptText, submitComposer, candidateImages). If
 * ChatGPT changes its markup, those are the only places you should need to touch.
 */
(() => {
  "use strict";

  // Guard against double injection (SPA navigations / re-inject).
  if (window.__cbigInjected) return;
  window.__cbigInjected = true;

  // ---------------------------------------------------------------------------
  // Selectors (ordered by preference; first match wins).
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    editor: [
      "#prompt-textarea",
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]',
      "textarea[data-id]",
      "main form textarea",
      "textarea",
    ],
    send: [
      '[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'form button[aria-label*="Send" i]',
    ],
    stop: [
      '[data-testid="stop-button"]',
      'button[data-testid="composer-stop-button"]',
      'button[aria-label*="Stop" i]',
    ],
    assistantTurn: '[data-message-author-role="assistant"]',
  };

  function pick(list) {
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Settings + state
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    prompts: "",
    prefix: "",
    folder: "chatgpt-bulk",
    startIndex: 1,
    pad: 2,
    ext: "png", // fallback extension; real one inferred from the blob when possible
    delayMs: 3000, // pause between prompts
    timeoutMs: 180000, // max wait for one image
    stableMs: 1500, // image src must hold steady this long to count as "done"
    skipOnFail: true,
    autoDownload: true, // false = only generate, don't download
  };

  let settings = { ...DEFAULTS };

  const state = {
    running: false,
    paused: false,
    cursor: 0, // index of next prompt to process (enables resume after Stop)
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  function getPrompts() {
    return String(settings.prompts || "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function numLabel(i) {
    return String(settings.startIndex + i).padStart(settings.pad, "0");
  }

  function buildPath(i, ext) {
    const folder = settings.folder
      ? settings.folder.replace(/^\/+|\/+$/g, "") + "/"
      : "";
    const safePrefix = settings.prefix.replace(/[\\/:*?"<>|]/g, "");
    return `${folder}${safePrefix}${numLabel(i)}.${ext}`;
  }

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (ui.log) {
      const div = document.createElement("div");
      div.className = "cbig-log-line";
      div.textContent = line;
      ui.log.appendChild(div);
      ui.log.scrollTop = ui.log.scrollHeight;
    }
    // Also mirror to console for debugging.
    console.log("[BulkImgGen]", msg);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get("cbigSettings", (data) => {
          if (data && data.cbigSettings) {
            settings = { ...DEFAULTS, ...data.cbigSettings };
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ cbigSettings: settings });
      } catch {
        /* ignore */
      }
    }, 250);
  }

  // ---------------------------------------------------------------------------
  // ChatGPT DOM interaction
  // ---------------------------------------------------------------------------
  function editorText(el) {
    return el.tagName === "TEXTAREA" ? el.value : el.textContent;
  }

  async function setPromptText(text) {
    const el = pick(SELECTORS.editor);
    if (!el) throw new Error("Composer input not found");
    el.focus();

    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable (ProseMirror). execCommand still works in Chrome and
      // is what ProseMirror reacts to most reliably.
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);

      if (!editorText(el).trim()) {
        // Fallback: replace children with a paragraph and fire an input event.
        el.innerHTML = "";
        const p = document.createElement("p");
        p.textContent = text;
        el.appendChild(p);
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text,
          })
        );
      }
    }

    const ok = await waitFor(
      () => editorText(el).trim().length > 0,
      3000,
      100
    );
    if (!ok) throw new Error("Composer did not accept the prompt text");
  }

  async function submitComposer() {
    // Wait for the send button to become enabled after text entry.
    await waitFor(
      () => {
        const b = pick(SELECTORS.send);
        return b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
      },
      4000,
      120
    );

    const btn = pick(SELECTORS.send);
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }

    // Fallback: press Enter in the editor.
    const el = pick(SELECTORS.editor);
    if (el) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
      return true;
    }
    throw new Error("Could not find a way to submit the prompt");
  }

  // --- Generated-image detection ---------------------------------------------
  // We do NOT rely on a specific message container (ChatGPT changes those
  // often). Instead we look for the largest raster <img> on the page that
  // appeared after we submitted the prompt — that is the generated image.

  function srcOf(im) {
    return im.currentSrc || im.src || "";
  }

  function imgSize(im) {
    const r = im.getBoundingClientRect();
    const w = Math.max(im.naturalWidth || 0, Math.round(r.width) || 0);
    const h = Math.max(im.naturalHeight || 0, Math.round(r.height) || 0);
    return { w, h, area: w * h };
  }

  function isChromeImg(im) {
    // Ignore nav / sidebar / header / profile / avatar imagery and vector icons.
    if (
      im.closest(
        'nav, header, aside, [data-testid*="profile" i], [class*="avatar" i]'
      )
    )
      return true;
    const src = srcOf(im);
    if (!src) return false; // keep: may be a not-yet-loaded generated image
    if (/\.svg(\?|$)|image\/svg/i.test(src)) return true;
    return false;
  }

  const MIN_IMG = 200; // generated images are large; avatars/icons are not

  function candidateImages() {
    return Array.from(document.images).filter((im) => {
      if (isChromeImg(im)) return false;
      const { w, h } = imgSize(im);
      return w >= MIN_IMG && h >= MIN_IMG;
    });
  }

  // Waits for a *new* finished image (largest <img> not present before submit).
  // Completion = its source has stayed identical AND decoded for `stableMs`.
  // We intentionally do NOT block on the "stop" button.
  async function waitForNewImage(prevSrcs) {
    const start = Date.now();
    let lastSrc = "";
    let stableSince = 0;
    let announced = false;

    while (Date.now() - start < settings.timeoutMs) {
      if (!state.running) return null;

      const fresh = candidateImages()
        .filter((im) => !prevSrcs.has(srcOf(im)))
        .sort((a, b) => imgSize(b).area - imgSize(a).area);
      const target = fresh[0] || null;

      if (target) {
        const src = srcOf(target);
        const { w, h } = imgSize(target);
        const decoded = target.complete && target.naturalWidth > 0;

        if (!announced) {
          log(`Detected image ${w}×${h}; waiting for it to finish…`);
          announced = true;
        }
        if (src && src === lastSrc && decoded) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= settings.stableMs) return target;
        } else {
          lastSrc = src;
          stableSince = 0;
        }
      }

      await sleep(350);
    }

    // Diagnostic: show the biggest images so we can tell whether the generated
    // one is even an <img>, and how large it is.
    const biggest = Array.from(document.images)
      .map((im) => imgSize(im))
      .filter((s) => s.w >= 100)
      .sort((a, b) => b.area - a.area)
      .slice(0, 5)
      .map((s) => `${s.w}×${s.h}`)
      .join(", ");
    log(
      `Timed out. Largest images on page: [${biggest || "none"}]. ` +
        `If your generated image is among them, tell me its size.`
    );
    return null;
  }

  // ---------------------------------------------------------------------------
  // Downloading
  // ---------------------------------------------------------------------------
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("Failed to read image blob"));
      fr.readAsDataURL(blob);
    });
  }

  function sendDownload(url, filename) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "download", url, filename }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false, error: "No response from background" });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  async function downloadImage(index, img) {
    let url = img.currentSrc || img.src;
    let ext = settings.ext;

    // For blob: and oaiusercontent URLs, fetch in-page (we have cookies + host
    // permission) and hand a data URL to the background downloader. This also
    // lets us learn the true file type.
    try {
      if (url.startsWith("blob:") || /oaiusercontent/i.test(url)) {
        const resp = await fetch(url);
        const blob = await resp.blob();
        if (blob.type && blob.type.startsWith("image/")) {
          ext = blob.type.split("/")[1].replace("jpeg", "jpg");
        }
        url = await blobToDataURL(blob);
      }
    } catch (e) {
      log(`Could not fetch image blob (${e.message}); trying direct URL.`);
    }

    const filename = buildPath(index, ext);
    const res = await sendDownload(url, filename);
    if (res.ok) log(`Saved ${filename}`);
    else log(`Download failed for ${filename}: ${res.error}`);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Run loop
  // ---------------------------------------------------------------------------
  async function runQueue() {
    if (state.running) return;

    const prompts = getPrompts();
    if (prompts.length === 0) {
      log("No prompts to run. Paste one prompt per line.");
      return;
    }
    if (!pick(SELECTORS.editor)) {
      log("Composer not found. Open a chat on chatgpt.com and try again.");
      return;
    }

    state.running = true;
    state.paused = false;
    if (state.cursor >= prompts.length) state.cursor = 0;
    reflectControls();
    log(`Starting at #${numLabel(state.cursor)} (${prompts.length} prompts).`);

    let completedAll = true;

    for (let i = state.cursor; i < prompts.length; i++) {
      if (!state.running) {
        completedAll = false;
        break;
      }
      while (state.paused && state.running) await sleep(300);
      if (!state.running) {
        completedAll = false;
        break;
      }

      state.cursor = i;
      setRowStatus(i, "submitting");

      try {
        const prevSrcs = new Set(candidateImages().map(srcOf));

        await setPromptText(prompts[i]);
        await submitComposer();
        setRowStatus(i, "generating");

        const img = await waitForNewImage(prevSrcs);
        if (!img) {
          setRowStatus(i, "timeout");
          log(`#${numLabel(i)} timed out after ${Math.round(settings.timeoutMs / 1000)}s.`);
          if (settings.skipOnFail) continue;
          completedAll = false;
          break;
        }

        if (settings.autoDownload) {
          setRowStatus(i, "downloading");
          const res = await downloadImage(i, img);
          setRowStatus(i, res.ok ? "done" : "failed");
        } else {
          setRowStatus(i, "generated");
          log(`#${numLabel(i)} generated (download skipped).`);
        }
      } catch (e) {
        setRowStatus(i, "error");
        log(`#${numLabel(i)} error: ${e.message}`);
        if (!settings.skipOnFail) {
          completedAll = false;
          break;
        }
      }

      if (i < prompts.length - 1) await sleep(settings.delayMs);
    }

    state.running = false;
    state.paused = false;
    if (completedAll) {
      state.cursor = 0;
      log("All prompts finished.");
    } else {
      log(`Stopped. Will resume from #${numLabel(state.cursor)}.`);
    }
    reflectControls();
  }

  function stopQueue() {
    if (!state.running) return;
    state.running = false;
    state.paused = false;
    log("Stopping after the current step...");
    reflectControls();
  }

  function togglePause() {
    if (!state.running) return;
    state.paused = !state.paused;
    log(state.paused ? "Paused." : "Resumed.");
    reflectControls();
  }

  // ---------------------------------------------------------------------------
  // UI (Shadow DOM so ChatGPT's CSS can't leak in)
  // ---------------------------------------------------------------------------
  const ui = {}; // filled in by buildPanel

  function buildPanel() {
    const host = document.createElement("div");
    host.id = "cbig-host";
    host.style.all = "initial";
    const root = host.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("panel.css");
    root.appendChild(link);

    const wrap = document.createElement("div");
    wrap.className = "cbig-panel";
    wrap.innerHTML = `
      <div class="cbig-header" data-drag>
        <span class="cbig-title">Bulk Image Generator</span>
        <div class="cbig-header-btns">
          <button class="cbig-icon" data-min title="Collapse">–</button>
        </div>
      </div>
      <div class="cbig-body">
        <label class="cbig-label">Prompts (one per line)</label>
        <textarea class="cbig-prompts" placeholder="a red fox in snow&#10;a city skyline at night&#10;a bowl of ramen, top down"></textarea>

        <div class="cbig-count">Detected images: <b class="cbig-num">0</b></div>
        <ol class="cbig-list"></ol>

        <details class="cbig-settings">
          <summary>Settings</summary>
          <div class="cbig-grid">
            <label>Folder<input data-k="folder" type="text"></label>
            <label>Prefix<input data-k="prefix" type="text" placeholder="(none)"></label>
            <label>Start #<input data-k="startIndex" type="number" min="0"></label>
            <label>Pad<input data-k="pad" type="number" min="1" max="6"></label>
            <label>Delay (ms)<input data-k="delayMs" type="number" min="0" step="500"></label>
            <label>Timeout (ms)<input data-k="timeoutMs" type="number" min="10000" step="5000"></label>
          </div>
          <label class="cbig-check"><input data-k="skipOnFail" type="checkbox"> Skip failed prompts and continue</label>
        </details>

        <label class="cbig-check cbig-autodl"><input data-k="autoDownload" type="checkbox"> Auto-download images (uncheck to only generate)</label>

        <div class="cbig-controls">
          <button class="cbig-btn cbig-start">Start</button>
          <button class="cbig-btn cbig-pause" disabled>Pause</button>
          <button class="cbig-btn cbig-stop" disabled>Stop</button>
        </div>

        <div class="cbig-log" aria-live="polite"></div>
      </div>
    `;
    root.appendChild(wrap);
    document.documentElement.appendChild(host);

    // Cache references.
    ui.host = host;
    ui.root = root;
    ui.panel = wrap;
    ui.prompts = root.querySelector(".cbig-prompts");
    ui.num = root.querySelector(".cbig-num");
    ui.list = root.querySelector(".cbig-list");
    ui.log = root.querySelector(".cbig-log");
    ui.startBtn = root.querySelector(".cbig-start");
    ui.pauseBtn = root.querySelector(".cbig-pause");
    ui.stopBtn = root.querySelector(".cbig-stop");

    // Restore values.
    ui.prompts.value = settings.prompts;
    root.querySelectorAll("[data-k]").forEach((input) => {
      const k = input.dataset.k;
      if (input.type === "checkbox") input.checked = !!settings[k];
      else input.value = settings[k];
    });

    // Wire events.
    ui.prompts.addEventListener("input", () => {
      settings.prompts = ui.prompts.value;
      saveSettings();
      renderList();
    });

    root.querySelectorAll("[data-k]").forEach((input) => {
      input.addEventListener("change", () => {
        const k = input.dataset.k;
        if (input.type === "checkbox") settings[k] = input.checked;
        else if (input.type === "number") settings[k] = Number(input.value);
        else settings[k] = input.value;
        saveSettings();
        renderList();
      });
    });

    ui.startBtn.addEventListener("click", () => runQueue());
    ui.pauseBtn.addEventListener("click", () => togglePause());
    ui.stopBtn.addEventListener("click", () => stopQueue());

    root
      .querySelector("[data-min]")
      .addEventListener("click", () => wrap.classList.toggle("cbig-collapsed"));

    makeDraggable(wrap, root.querySelector("[data-drag]"));
    renderList();
    reflectControls();
  }

  function renderList() {
    const prompts = getPrompts();
    ui.num.textContent = String(prompts.length);
    ui.list.innerHTML = "";
    prompts.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "cbig-row";
      li.dataset.i = String(i);
      li.innerHTML = `
        <span class="cbig-badge" data-badge>queued</span>
        <span class="cbig-rownum">${numLabel(i)}</span>
        <span class="cbig-rowtext"></span>
      `;
      li.querySelector(".cbig-rowtext").textContent = p;
      ui.list.appendChild(li);
    });
  }

  const STATUS_LABEL = {
    submitting: "typing",
    generating: "generating",
    downloading: "saving",
    done: "done",
    generated: "generated",
    timeout: "timeout",
    failed: "save failed",
    error: "error",
  };

  function setRowStatus(i, status) {
    const li = ui.list && ui.list.querySelector(`.cbig-row[data-i="${i}"]`);
    if (!li) return;
    const badge = li.querySelector("[data-badge]");
    badge.textContent = STATUS_LABEL[status] || status;
    badge.className = "cbig-badge cbig-s-" + status;
    li.scrollIntoView({ block: "nearest" });
  }

  function reflectControls() {
    if (!ui.startBtn) return;
    ui.startBtn.disabled = state.running;
    ui.pauseBtn.disabled = !state.running;
    ui.stopBtn.disabled = !state.running;
    ui.pauseBtn.textContent = state.paused ? "Resume" : "Pause";
    ui.prompts.disabled = state.running;
    ui.startBtn.textContent =
      !state.running && state.cursor > 0 ? "Resume queue" : "Start";
  }

  function makeDraggable(panel, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.style.cursor = "move";
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      sx = e.clientX;
      sy = e.clientY;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = ox + (e.clientX - sx) + "px";
      panel.style.top = oy + (e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => (dragging = false));
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  (async function init() {
    await loadSettings();
    buildPanel();
    log("Ready. Paste prompts, then click Start.");
  })();
})();
