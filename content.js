/* ChatGPT Bulk Image Generator — automation engine (content script)
 *
 * Runs inside chatgpt.com. It has no UI of its own — the UI lives in the
 * browser's side panel (sidepanel.html / sidepanel.js). This script:
 *   • receives commands from the panel  (chrome.tabs.sendMessage → onMessage)
 *   • drives the ChatGPT DOM: types each prompt, waits for the generated image,
 *     downloads it as 01.png, 02.png, …
 *   • reports progress back to the panel (chrome.runtime.sendMessage events)
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
  // Panel messaging — the engine's only "output". Wrapped so a closed panel
  // (no receiving end) never throws or spams the console.
  // ---------------------------------------------------------------------------
  function emit(evt, data) {
    try {
      chrome.runtime.sendMessage(
        { type: "cbig-evt", evt, ...(data || {}) },
        () => void chrome.runtime.lastError
      );
    } catch {
      /* extension context gone */
    }
  }

  function log(msg) {
    emit("log", { msg });
    console.log("[BulkImgGen]", msg);
  }

  function emitState() {
    emit("state", {
      running: state.running,
      paused: state.paused,
      cursor: state.cursor,
    });
  }

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

  // ---------------------------------------------------------------------------
  // Storage — the panel is the source of truth (it sends settings with "start"),
  // but we load here too so the engine still works if commanded before a sync.
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

  // ---------------------------------------------------------------------------
  // Progress checkpoint — persisted to chrome.storage.local so an unexpected
  // shutdown (or a tab reload / SPA re-inject) doesn't lose our place and
  // restart at image #01. We save the cursor after every prompt; on load we
  // restore it, so pressing Start resumes from the *next* image, not the first.
  // ---------------------------------------------------------------------------
  const PROGRESS_KEY = "cbigProgress";

  // Cheap, stable signature of the queue so the panel can tell when the saved
  // position belongs to a different prompt list.
  function promptsSig(prompts) {
    const s = prompts.join("\n");
    let h = 0;
    for (let i = 0; i < s.length; i++)
      h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return `${prompts.length}:${h}`;
  }

  function saveProgress() {
    try {
      chrome.storage.local.set({
        [PROGRESS_KEY]: {
          cursor: state.cursor,
          sig: promptsSig(getPrompts()),
          startIndex: settings.startIndex,
          updatedAt: Date.now(),
        },
      });
    } catch {
      /* ignore */
    }
  }

  // Reset the checkpoint to the first image (whole queue finished, or on demand).
  function clearProgress() {
    state.cursor = 0;
    saveProgress();
  }

  // Restore the saved cursor into state. Resolves with the stored record (or null).
  function loadProgress() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(PROGRESS_KEY, (data) => {
          const p = data && data[PROGRESS_KEY];
          if (p && typeof p.cursor === "number")
            state.cursor = Math.max(0, p.cursor);
          resolve(p || null);
        });
      } catch {
        resolve(null);
      }
    });
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
  // Row status → panel
  // ---------------------------------------------------------------------------
  function setRowStatus(i, status) {
    emit("status", { i, status });
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
    emitState();
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
      saveProgress();
      setRowStatus(i, "submitting");

      try {
        const prevSrcs = new Set(candidateImages().map(srcOf));

        await setPromptText(prompts[i]);
        await submitComposer();
        setRowStatus(i, "generating");

        const img = await waitForNewImage(prevSrcs);
        if (!img) {
          // A null image means either a real timeout, or the user pressed Stop
          // mid-generation (waitForNewImage bails when !state.running). Only
          // treat it as a finished-and-skippable step in the former case —
          // otherwise leave the checkpoint on i so resume re-runs this image.
          if (!state.running) {
            completedAll = false;
            break;
          }
          setRowStatus(i, "timeout");
          log(`#${numLabel(i)} timed out after ${Math.round(settings.timeoutMs / 1000)}s.`);
          if (settings.skipOnFail) {
            // Checkpoint past the skipped one so a crash won't re-run it.
            state.cursor = i + 1;
            saveProgress();
            continue;
          }
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

        // Image i is finished — advance the persisted checkpoint so that after
        // an unexpected shutdown we resume from the *next* image, not this one.
        state.cursor = i + 1;
        saveProgress();
      } catch (e) {
        setRowStatus(i, "error");
        log(`#${numLabel(i)} error: ${e.message}`);
        if (!settings.skipOnFail) {
          completedAll = false;
          break;
        }
        state.cursor = i + 1;
        saveProgress();
      }

      if (i < prompts.length - 1) await sleep(settings.delayMs);
    }

    state.running = false;
    state.paused = false;
    if (completedAll) {
      clearProgress();
      log("All prompts finished.");
    } else {
      saveProgress();
      log(`Stopped. Will resume from #${numLabel(state.cursor)}.`);
    }
    emitState();
  }

  function stopQueue() {
    if (!state.running) return;
    state.running = false;
    state.paused = false;
    log("Stopping after the current step...");
    emitState();
  }

  function togglePause() {
    if (!state.running) return;
    state.paused = !state.paused;
    log(state.paused ? "Paused." : "Resumed.");
    emitState();
  }

  // ---------------------------------------------------------------------------
  // Init — load settings, then listen for commands from the side panel.
  // ---------------------------------------------------------------------------
  (async function init() {
    await loadSettings();
    // Restore the saved checkpoint so a crash/reload resumes from the next
    // image instead of #01. The panel reads the same key to show the resume point.
    await loadProgress();

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "cbig-cmd") return;

      switch (msg.action) {
        case "start":
          if (msg.settings) settings = { ...settings, ...msg.settings };
          // Honor an explicit resume point from the panel ("Start from image #").
          if (typeof msg.resumeAt === "number")
            state.cursor = Math.max(0, msg.resumeAt);
          runQueue();
          break;
        case "pause":
          togglePause();
          break;
        case "stop":
          stopQueue();
          break;
        case "reset":
          // Panel asked to clear the checkpoint (e.g. user reset the resume #).
          if (!state.running) clearProgress();
          emitState();
          break;
        case "sync":
          // Let a freshly-opened panel restore correct button state mid-run.
          sendResponse({
            running: state.running,
            paused: state.paused,
            cursor: state.cursor,
          });
          break;
      }
      // Only "sync" replies; the rest are fire-and-forget.
    });

    console.log("[BulkImgGen] engine ready");
  })();
})();
