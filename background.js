// Background service worker (MV3).
// Content scripts cannot call chrome.downloads directly, so the side panel's
// engine (content.js) sends download requests here and we perform them with a
// custom filename.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "download") return;

  chrome.downloads.download(
    {
      url: msg.url,
      filename: msg.filename,
      saveAs: false,
      conflictAction: "uniquify",
    },
    (downloadId) => {
      const err = chrome.runtime.lastError;
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
