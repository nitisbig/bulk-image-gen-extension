/* ChatGPT Bulk Image Generator — side panel UI
 *
 * This runs in Chrome's native side panel (a separate extension page). It owns
 * the whole UI: paste prompts (one per line), tweak settings, watch progress.
 *
 * It does NOT touch the ChatGPT page directly — a side panel can't. Instead it
 * talks to the automation engine in content.js over messages:
 *   • panel → engine:  chrome.tabs.sendMessage(tabId, {type:"cbig-cmd", action})
 *   • engine → panel:  chrome.runtime.sendMessage({type:"cbig-evt", evt, ...})
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Settings (mirror of the engine's DEFAULTS; persisted to chrome.storage).
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    prompts: "",
    prefix: "",
    folder: "chatgpt-bulk",
    startIndex: 1,
    pad: 2,
    ext: "png",
    delayMs: 3000,
    timeoutMs: 180000,
    stableMs: 1500,
    skipOnFail: true,
    autoDownload: true,
  };

  let settings = { ...DEFAULTS };

  // Mirror of the engine's run state; kept in sync via "state" events.
  const runState = { running: false, paused: false, cursor: 0 };
  // The persisted checkpoint record (from chrome.storage), used to detect when
  // the saved resume point belongs to a different prompt list.
  let checkpoint = null;
  // Whether a chatgpt.com tab (with the engine) is currently reachable.
  let hasTab = false;
  // The tab a run was started in. Pause/Stop target this so they still reach the
  // right tab if the user switches away mid-run. Cleared when the run ends.
  let activeRunTabId = null;

  const ui = {}; // filled in by buildPanel

  // Tabs the engine runs in.
  const CHAT_URLS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
  const isChatUrl = (url) =>
    !!url && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url);

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function getPrompts() {
    return String(settings.prompts || "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function numLabel(i) {
    return String(settings.startIndex + i).padStart(settings.pad, "0");
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
    console.log("[BulkImgGen]", msg);
  }

  // ---------------------------------------------------------------------------
  // Storage (same cbigSettings key as before → existing saved settings persist)
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
  // Checkpoint (resume point). The engine persists this under "cbigProgress"
  // after every image so an unexpected shutdown doesn't restart at #01. The
  // panel reads it to show/edit where the next Start will resume from.
  // ---------------------------------------------------------------------------
  const PROGRESS_KEY = "cbigProgress";

  // Must match content.js promptsSig so we can tell if the saved checkpoint
  // belongs to the prompt list currently in the textarea.
  function promptsSig(prompts) {
    const s = prompts.join("\n");
    let h = 0;
    for (let i = 0; i < s.length; i++)
      h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return `${prompts.length}:${h}`;
  }

  function loadProgress() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(PROGRESS_KEY, (data) => {
          checkpoint = (data && data[PROGRESS_KEY]) || null;
          resolve(checkpoint);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // Persist an explicit resume cursor from the panel (e.g. the user edited the
  // "Start from image #" field). Keeps the same shape the engine writes.
  function saveProgress(cursor) {
    const prompts = getPrompts();
    checkpoint = {
      cursor: Math.max(0, cursor | 0),
      sig: promptsSig(prompts),
      startIndex: settings.startIndex,
      updatedAt: Date.now(),
    };
    try {
      chrome.storage.local.set({ [PROGRESS_KEY]: checkpoint });
    } catch {
      /* ignore */
    }
  }

  function clearProgress() {
    checkpoint = null;
    try {
      chrome.storage.local.remove(PROGRESS_KEY);
    } catch {
      /* ignore */
    }
  }

  // The 0-based index the next Start will resume from, clamped to the queue.
  function resumeCursor() {
    const n = getPrompts().length;
    const c = checkpoint && typeof checkpoint.cursor === "number"
      ? checkpoint.cursor
      : 0;
    return Math.min(Math.max(0, c), Math.max(0, n));
  }

  // ---------------------------------------------------------------------------
  // Inline SVG icons (Lucide-style, consistent 1.75 stroke).
  // ---------------------------------------------------------------------------
  const svg = (inner, o = {}) =>
    `<svg viewBox="0 0 24 24" fill="${o.fill || "none"}" stroke="${
      o.stroke || "currentColor"
    }" stroke-width="${o.sw || 1.75}" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

  const ICONS = {
    logo: svg(
      '<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>'
    ),
    chevron: svg('<path d="m6 9 6 6 6-6"/>'),
    play: svg('<path d="M6 4.5v15l13-7.5z"/>', {
      fill: "currentColor",
      stroke: "none",
    }),
    pause: svg(
      '<rect x="6.5" y="4.5" width="4" height="15" rx="1"/><rect x="13.5" y="4.5" width="4" height="15" rx="1"/>',
      { fill: "currentColor", stroke: "none" }
    ),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', {
      fill: "currentColor",
      stroke: "none",
    }),
    settings: svg(
      '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'
    ),
    empty: svg(
      '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
    ),
    alert: svg(
      '<circle cx="12" cy="12" r="9"/><line x1="12" x2="12" y1="8" y2="13"/><line x1="12" x2="12.01" y1="16.5" y2="16.5"/>'
    ),
    reset: svg('<path d="M3 12a9 9 0 1 0 3-6.74L3 8"/><path d="M3 3v5h5"/>'),
    save: svg(
      '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>'
    ),
  };

  // ---------------------------------------------------------------------------
  // Build the panel into <body>
  // ---------------------------------------------------------------------------
  function buildPanel() {
    const wrap = document.createElement("div");
    wrap.className = "cbig-panel";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Bulk Image Generator");
    wrap.innerHTML = `
      <div class="cbig-header">
        <span class="cbig-logo">${ICONS.logo}</span>
        <span class="cbig-heading">
          <span class="cbig-title">Bulk Image Generator</span>
          <span class="cbig-subtitle">Queue prompts → auto-download</span>
        </span>
      </div>
      <div class="cbig-body">
        <div class="cbig-hint" data-hint hidden>
          ${ICONS.alert}
          <span>Open a <b>chatgpt.com</b> tab, then press Start.</span>
        </div>

        <div class="cbig-field">
          <div class="cbig-label-row">
            <label class="cbig-label" for="cbig-prompts">Prompts</label>
            <span class="cbig-chip"><b class="cbig-num">0</b>&nbsp;queued</span>
          </div>
          <textarea id="cbig-prompts" class="cbig-prompts" spellcheck="false" placeholder="One prompt per line…&#10;a red fox in snow&#10;a city skyline at night&#10;a bowl of ramen, top down"></textarea>
        </div>

        <div class="cbig-progress" role="progressbar" aria-label="Queue progress" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
          <div class="cbig-progress-head">
            <span class="cbig-progress-count"><b class="cbig-done">0</b><small>&nbsp;/&nbsp;<span class="cbig-total">0</span> processed</small></span>
            <span class="cbig-progress-pct">0%</span>
          </div>
          <div class="cbig-track"><div class="cbig-track-fill"></div></div>
          <div class="cbig-stats">
            <span class="cbig-stat cbig-stat-done"><b class="cbig-stat-done-n">0</b>&nbsp;done</span>
            <span class="cbig-stat cbig-stat-fail"><b class="cbig-stat-fail-n">0</b>&nbsp;failed</span>
            <span class="cbig-stat cbig-stat-left"><b class="cbig-stat-left-n">0</b>&nbsp;left</span>
          </div>
        </div>

        <ol class="cbig-list" aria-label="Prompt queue"></ol>
        <div class="cbig-empty" data-empty>
          ${ICONS.empty}
          <span class="cbig-empty-title">No prompts yet</span>
          <span class="cbig-empty-sub">Paste one prompt per line above. They'll appear here, numbered and ready to generate.</span>
        </div>

        <details class="cbig-settings">
          <summary>${ICONS.settings}<span>Settings</span><span class="cbig-chevron">${ICONS.chevron}</span></summary>
          <div class="cbig-settings-body">
            <div class="cbig-grid">
              <label>Folder<input data-k="folder" type="text" spellcheck="false"></label>
              <label>Prefix<input data-k="prefix" type="text" spellcheck="false" placeholder="(none)"></label>
              <label>Start #<input data-k="startIndex" type="number" min="0"></label>
              <label>Zero-pad<input data-k="pad" type="number" min="1" max="6"></label>
              <label>Delay (ms)<input data-k="delayMs" type="number" min="0" step="500"></label>
              <label>Timeout (ms)<input data-k="timeoutMs" type="number" min="10000" step="5000"></label>
            </div>
            <label class="cbig-switch">
              <input data-k="skipOnFail" type="checkbox">
              <span class="cbig-track-sw"></span>
              <span class="cbig-switch-text">Skip failed prompts<small>Continue past a timeout or error</small></span>
            </label>
          </div>
        </details>

        <label class="cbig-switch cbig-autodl">
          <input data-k="autoDownload" type="checkbox">
          <span class="cbig-track-sw"></span>
          <span class="cbig-switch-text">Auto-download images<small>Uncheck to only generate, no saving</small></span>
        </label>

        <div class="cbig-resume" data-resume>
          <div class="cbig-resume-head">
            <span class="cbig-resume-title">${ICONS.save}<span>Resume point</span></span>
            <span class="cbig-resume-badge" data-resume-badge hidden>checkpoint saved</span>
          </div>
          <div class="cbig-resume-row">
            <label class="cbig-resume-field">
              <span>Start from image #</span>
              <input class="cbig-resume-input" type="number" min="0" inputmode="numeric">
            </label>
            <button class="cbig-btn cbig-reset" type="button" title="Reset to the first image">${ICONS.reset}<span>Reset</span></button>
          </div>
          <p class="cbig-resume-hint" data-resume-hint></p>
        </div>

        <div class="cbig-controls">
          <button class="cbig-btn cbig-start" type="button">${ICONS.play}<span class="cbig-start-label">Start</span></button>
          <button class="cbig-btn cbig-pause" type="button" disabled aria-label="Pause">${ICONS.pause}<span>Pause</span></button>
          <button class="cbig-btn cbig-stop" type="button" disabled aria-label="Stop">${ICONS.stop}</button>
        </div>

        <div class="cbig-log-wrap">
          <span class="cbig-label">Activity</span>
          <div class="cbig-log" aria-live="polite" aria-label="Activity log"></div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // Cache references.
    ui.panel = wrap;
    ui.hint = wrap.querySelector("[data-hint]");
    ui.prompts = wrap.querySelector(".cbig-prompts");
    ui.num = wrap.querySelector(".cbig-num");
    ui.list = wrap.querySelector(".cbig-list");
    ui.empty = wrap.querySelector("[data-empty]");
    ui.log = wrap.querySelector(".cbig-log");
    ui.startBtn = wrap.querySelector(".cbig-start");
    ui.startLabel = wrap.querySelector(".cbig-start-label");
    ui.pauseBtn = wrap.querySelector(".cbig-pause");
    ui.stopBtn = wrap.querySelector(".cbig-stop");

    // Resume point (checkpoint) controls.
    ui.resume = wrap.querySelector("[data-resume]");
    ui.resumeInput = wrap.querySelector(".cbig-resume-input");
    ui.resumeBadge = wrap.querySelector("[data-resume-badge]");
    ui.resumeHint = wrap.querySelector("[data-resume-hint]");
    ui.resetBtn = wrap.querySelector(".cbig-reset");

    // Progress + stats.
    ui.progress = wrap.querySelector(".cbig-progress");
    ui.trackFill = wrap.querySelector(".cbig-track-fill");
    ui.progressPct = wrap.querySelector(".cbig-progress-pct");
    ui.doneNum = wrap.querySelector(".cbig-done");
    ui.totalNum = wrap.querySelector(".cbig-total");
    ui.statDone = wrap.querySelector(".cbig-stat-done-n");
    ui.statFail = wrap.querySelector(".cbig-stat-fail-n");
    ui.statLeft = wrap.querySelector(".cbig-stat-left-n");

    // Restore values.
    ui.prompts.value = settings.prompts;
    wrap.querySelectorAll("[data-k]").forEach((input) => {
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

    wrap.querySelectorAll("[data-k]").forEach((input) => {
      input.addEventListener("change", () => {
        const k = input.dataset.k;
        if (input.type === "checkbox") settings[k] = input.checked;
        else if (input.type === "number") settings[k] = Number(input.value);
        else settings[k] = input.value;
        saveSettings();
        renderList();
      });
    });

    ui.startBtn.addEventListener("click", () => {
      settings.prompts = ui.prompts.value;
      saveSettings();
      sendCmd("start", { settings, resumeAt: resumeCursor() });
    });
    ui.pauseBtn.addEventListener("click", () => sendCmd("pause"));
    ui.stopBtn.addEventListener("click", () => sendCmd("stop"));

    // "Start from image #": the field shows the same number as the row labels
    // and filenames (startIndex + cursor). Convert back to a 0-based cursor.
    ui.resumeInput.addEventListener("change", () => {
      const n = getPrompts().length;
      const entered = Number(ui.resumeInput.value);
      let cursor = (Number.isFinite(entered) ? entered : settings.startIndex) -
        settings.startIndex;
      cursor = Math.min(Math.max(0, cursor), n);
      saveProgress(cursor);
      renderResume();
      log(
        cursor >= n && n > 0
          ? "Resume point set past the end — Start will run from #1."
          : `Resume point set to #${numLabel(cursor)}.`
      );
    });

    ui.resetBtn.addEventListener("click", () => {
      clearProgress();
      sendCmd("reset");
      renderResume();
      log("Resume point reset to the first image.");
    });

    renderList();
    updateControls();
  }

  // ---------------------------------------------------------------------------
  // Rendering (identical semantics to the old in-page panel)
  // ---------------------------------------------------------------------------
  function renderList() {
    const prompts = getPrompts();
    ui.num.textContent = String(prompts.length);
    if (ui.empty) ui.empty.style.display = prompts.length ? "none" : "flex";
    ui.list.innerHTML = "";
    prompts.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "cbig-row";
      li.dataset.i = String(i);
      li.innerHTML = `
        <span class="cbig-dot"></span>
        <span class="cbig-rownum">${numLabel(i)}</span>
        <span class="cbig-rowtext"></span>
        <span class="cbig-badge" data-badge>queued</span>
      `;
      const text = li.querySelector(".cbig-rowtext");
      text.textContent = p;
      text.title = p; // full prompt on hover when the row is truncated
      ui.list.appendChild(li);
    });
    updateStats();
    renderResume();
  }

  // Reflect the saved checkpoint in the resume card: the editable "Start from
  // image #" field, a saved badge, and a hint (idle position, or a mismatch
  // warning when the checkpoint was saved against a different prompt list).
  function renderResume() {
    if (!ui.resume) return;
    const prompts = getPrompts();
    const n = prompts.length;
    const cursor = resumeCursor();

    // Field is disabled while running (the engine owns the cursor then) and
    // shows the human-facing number (startIndex + cursor).
    if (ui.resumeInput) {
      ui.resumeInput.disabled = runState.running;
      if (document.activeElement !== ui.resumeInput)
        ui.resumeInput.value = String(settings.startIndex + cursor);
    }

    const hasCheckpoint = !!checkpoint && cursor > 0;
    if (ui.resumeBadge) ui.resumeBadge.hidden = !hasCheckpoint;

    if (ui.resumeHint) {
      let hint;
      if (runState.running) {
        hint = `Running — currently on #${numLabel(runState.cursor)}.`;
      } else if (n === 0) {
        hint = "Add prompts, then choose where to begin.";
      } else if (cursor >= n) {
        hint = "All images done. Start will run the whole queue again from #1.";
      } else if (checkpoint && checkpoint.sig && checkpoint.sig !== promptsSig(prompts)) {
        // The prompt list changed since the checkpoint was written.
        hint = `Prompts changed since this checkpoint — Start resumes at #${numLabel(
          cursor
        )}. Verify or Reset.`;
      } else if (cursor > 0) {
        hint = `Saved. Start will resume from #${numLabel(cursor)} (${n -
          cursor} left).`;
      } else {
        hint = `Start will begin at #${numLabel(0)}.`;
      }
      ui.resumeHint.textContent = hint;
      ui.resumeHint.classList.toggle(
        "is-warn",
        !runState.running &&
          !!checkpoint &&
          !!checkpoint.sig &&
          checkpoint.sig !== promptsSig(prompts)
      );
    }
  }

  // Recompute the progress bar + stat counts from the current row statuses.
  function updateStats() {
    if (!ui.list) return;
    const rows = Array.from(ui.list.querySelectorAll(".cbig-row"));
    const total = rows.length;
    let done = 0;
    let failed = 0;
    rows.forEach((li) => {
      const cls = (li.querySelector("[data-badge]") || {}).className || "";
      if (/cbig-s-(?:done|generated)\b/.test(cls)) done++;
      else if (/cbig-s-(?:timeout|failed|error)\b/.test(cls)) failed++;
    });
    const finished = done + failed;
    const left = Math.max(0, total - finished);
    const pct = total ? Math.round((finished / total) * 100) : 0;

    if (ui.progress) {
      ui.progress.classList.toggle("is-visible", total > 0);
      ui.progress.setAttribute("aria-valuemax", String(total));
      ui.progress.setAttribute("aria-valuenow", String(finished));
    }
    if (ui.trackFill) ui.trackFill.style.width = pct + "%";
    if (ui.progressPct) ui.progressPct.textContent = pct + "%";
    if (ui.doneNum) ui.doneNum.textContent = String(finished);
    if (ui.totalNum) ui.totalNum.textContent = String(total);
    if (ui.statDone) ui.statDone.textContent = String(done);
    if (ui.statFail) ui.statFail.textContent = String(failed);
    if (ui.statLeft) ui.statLeft.textContent = String(left);
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
    const active =
      status === "submitting" ||
      status === "generating" ||
      status === "downloading";
    li.classList.toggle("is-active", active);
    li.scrollIntoView({ block: "nearest" });
    updateStats();
  }

  // Buttons + running affordances, driven by runState (from "state" events) and
  // by whether a chatgpt.com tab is reachable.
  function updateControls() {
    if (!ui.startBtn) return;
    const running = runState.running;
    ui.startBtn.disabled = running || !hasTab;
    ui.pauseBtn.disabled = !running;
    ui.stopBtn.disabled = !running;
    ui.prompts.disabled = running;

    ui.pauseBtn.innerHTML = runState.paused
      ? ICONS.play + "<span>Resume</span>"
      : ICONS.pause + "<span>Pause</span>";
    ui.pauseBtn.setAttribute("aria-label", runState.paused ? "Resume" : "Pause");

    if (ui.startLabel) {
      const canResume = runState.cursor > 0 || resumeCursor() > 0;
      ui.startLabel.textContent = !running && canResume ? "Resume queue" : "Start";
    }

    ui.panel.classList.toggle("cbig-running", running);
    if (ui.hint) ui.hint.hidden = hasTab;
    updateStats();
  }

  // ---------------------------------------------------------------------------
  // Messaging with the engine (content.js)
  // ---------------------------------------------------------------------------

  // Resolve the tab to command: prefer the active tab if it's chatgpt.com,
  // otherwise the first chatgpt.com tab anywhere. null = none open.
  function resolveTargetTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const active = tabs && tabs[0];
          if (active && isChatUrl(active.url)) {
            resolve(active.id);
            return;
          }
          chrome.tabs.query({ url: CHAT_URLS }, (all) => {
            const t = all && all[0];
            resolve(t ? t.id : null);
          });
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function refreshTabAvailability() {
    const tabId = await resolveTargetTab();
    hasTab = tabId != null;
    updateControls();
  }

  // Send a command to the engine. Returns the engine's response (or null).
  async function sendCmd(action, extra) {
    // Pause/Stop must reach the tab the run started in, even if the user has
    // since switched to another tab. Start/sync resolve the target dynamically.
    let tabId = null;
    if ((action === "pause" || action === "stop") && activeRunTabId != null) {
      tabId = activeRunTabId;
    } else {
      tabId = await resolveTargetTab();
      hasTab = tabId != null;
      updateControls();
    }

    if (tabId == null) {
      if (action === "start")
        log("No chatgpt.com tab found. Open one and press Start.");
      return null;
    }

    if (action === "start") activeRunTabId = tabId;

    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(
          tabId,
          { type: "cbig-cmd", action, ...(extra || {}) },
          (res) => {
            if (chrome.runtime.lastError) {
              // Engine not present yet (page loaded before the extension, or
              // still loading). Ask the user to reload.
              if (action === "start") {
                activeRunTabId = null;
                log("Couldn't reach the page — reload the chatgpt.com tab and retry.");
              }
              resolve(null);
            } else {
              resolve(res || null);
            }
          }
        );
      } catch {
        if (action === "start") activeRunTabId = null;
        resolve(null);
      }
    });
  }

  // Ask the engine for its current run state so the buttons are correct when the
  // panel (re)opens mid-run.
  async function syncFromEngine() {
    const res = await sendCmd("sync");
    if (res && typeof res.running === "boolean") {
      runState.running = res.running;
      runState.paused = res.paused;
      runState.cursor = res.cursor;
      updateControls();
      renderResume();
    }
  }

  function applyEvent(msg) {
    switch (msg.evt) {
      case "log":
        log(msg.msg);
        break;
      case "status":
        setRowStatus(msg.i, msg.status);
        break;
      case "state":
        runState.running = msg.running;
        runState.paused = msg.paused;
        runState.cursor = msg.cursor;
        if (!msg.running) activeRunTabId = null;
        updateControls();
        renderResume();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  (async function init() {
    await loadSettings();
    await loadProgress();
    buildPanel();

    // Engine → panel events.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "cbig-evt") applyEvent(msg);
    });

    // The engine checkpoints progress to chrome.storage after every image.
    // Mirror those writes so the resume point stays live without polling.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[PROGRESS_KEY]) return;
        checkpoint = changes[PROGRESS_KEY].newValue || null;
        renderResume();
      });
    } catch {
      /* storage events unavailable — sync still refreshes on panel open */
    }

    // Keep Start availability in sync as the user switches/loads tabs.
    try {
      chrome.tabs.onActivated.addListener(() => refreshTabAvailability());
      chrome.tabs.onUpdated.addListener((_id, info) => {
        if (info && (info.status === "complete" || info.url))
          refreshTabAvailability();
      });
      chrome.windows.onFocusChanged.addListener(() => refreshTabAvailability());
    } catch {
      /* events unavailable — the pre-command check in sendCmd still guards us */
    }

    await refreshTabAvailability();
    await syncFromEngine();

    log("Ready. Paste prompts, then click Start.");
  })();
})();
