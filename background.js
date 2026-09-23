// Background service worker (MV3).
// Content scripts cannot call chrome.downloads directly, so the side panel's
// engine (content.js) sends download requests here and we perform them with a
// custom filename.

// Chrome ignores DownloadOptions.filename whenever any extension registers an
// onDeterminingFilename listener. Keep the requested name until that event and
// explicitly suggest it for downloads started by this extension.
const pendingNames = new Map();

function removePendingName(url, request) {
  const queue = pendingNames.get(url);
  if (!queue) return;
  const index = queue.indexOf(request);
  if (index !== -1) queue.splice(index, 1);
  if (queue.length === 0) pendingNames.delete(url);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return;
  }

  const queue = pendingNames.get(item.url);
  if (!queue || queue.length === 0) {
    suggest();
    return;
  }

  const request = queue[0];
  removePendingName(item.url, request);
  suggest({ filename: request.filename, conflictAction: "uniquify" });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "download") return;

  const request = { filename: msg.filename };
  const queue = pendingNames.get(msg.url) || [];
  queue.push(request);
  pendingNames.set(msg.url, queue);

  chrome.downloads.download(
    {
      url: msg.url,
      filename: msg.filename,
      saveAs: false,
      conflictAction: "uniquify",
    },
    (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err || downloadId === undefined) removePendingName(msg.url, request);
      sendResponse({
        ok: !err && downloadId !== undefined,
        downloadId: downloadId,
        error: err ? err.message : null,
      });
    }
  );

  // Return true to keep the message channel open for the async sendResponse.
  return true;
});

// Toolbar icon → open the browser's native side panel. openPanelOnActionClick
// makes Chrome open the panel (side_panel.default_path from the manifest) on
// click with no extra code and no "tabs" permission. Do NOT also register
// chrome.action.onClicked — it conflicts with this behavior.
function enableSidePanelOnClick() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[BulkImgGen] side panel setup failed:", err));
}

// Run on install/update and on every service-worker startup (the setting is
// per-session for an unpacked extension, so re-applying is cheap and safe).
chrome.runtime.onInstalled.addListener(enableSidePanelOnClick);
enableSidePanelOnClick();
