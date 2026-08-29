// Background service worker (MV3).
// Content scripts cannot call chrome.downloads directly, so the panel sends
// download requests here and we perform them with a custom filename.

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

// Toolbar icon → toggle the in-page panel on the active tab. We have host
// permission for chatgpt.com, so no extra "tabs" permission is needed. On tabs
// without the content script (e.g. a new tab) the message has no receiver, so
// we swallow the resulting lastError.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }, () => {
    void chrome.runtime.lastError;
  });
});
