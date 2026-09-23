const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground() {
  let onMessage;
  let onDeterminingFilename;
  const downloads = [];
  const chrome = {
    runtime: {
      id: "bulk-image-extension",
      lastError: null,
      onMessage: { addListener(fn) { onMessage = fn; } },
      onInstalled: { addListener() {} },
    },
    downloads: {
      onDeterminingFilename: {
        addListener(fn) { onDeterminingFilename = fn; },
      },
      download(options, callback) { downloads.push({ options, callback }); },
    },
    sidePanel: null,
  };
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
  vm.runInNewContext(source, { chrome, console });
  return { chrome, downloads, onMessage, onDeterminingFilename };
}

test("suggests the numbered filename when Chrome determines the download name", () => {
  const bg = loadBackground();
  const responses = [];
  bg.onMessage(
    { type: "download", url: "data:image/png;base64,abc", filename: "chatgpt-bulk/01.png" },
    {},
    (response) => responses.push(response)
  );

  assert.equal(bg.downloads[0].options.filename, "chatgpt-bulk/01.png");
  let suggestion;
  bg.onDeterminingFilename(
    { url: "data:image/png;base64,abc", byExtensionId: bg.chrome.runtime.id },
    (value) => { suggestion = value; }
  );
  assert.equal(suggestion.filename, "chatgpt-bulk/01.png");
  assert.equal(suggestion.conflictAction, "uniquify");
  bg.downloads[0].callback(42);
  assert.equal(responses[0].ok, true);
});

test("keeps consecutive names separate and leaves unrelated downloads alone", () => {
  const bg = loadBackground();
  const url = "data:image/png;base64,same-image";
  bg.onMessage({ type: "download", url, filename: "01.png" }, {}, () => {});
  bg.onMessage({ type: "download", url, filename: "02.png" }, {}, () => {});

  let unrelated = "not called";
  bg.onDeterminingFilename(
    { url, byExtensionId: "another-extension" },
    (value) => { unrelated = value; }
  );
  assert.equal(unrelated, undefined);

  const names = [];
  for (let i = 0; i < 2; i++) {
    bg.onDeterminingFilename(
      { url, byExtensionId: bg.chrome.runtime.id },
      (value) => names.push(value.filename)
    );
  }
  assert.deepEqual(names, ["01.png", "02.png"]);
});

test("removes a failed request so it cannot name a later download", () => {
  const bg = loadBackground();
  const url = "data:image/png;base64,retry";
  bg.onMessage({ type: "download", url, filename: "01.png" }, {}, () => {});
  bg.chrome.runtime.lastError = { message: "Download failed" };
  bg.downloads[0].callback(undefined);
  bg.chrome.runtime.lastError = null;

  bg.onMessage({ type: "download", url, filename: "02.png" }, {}, () => {});
  let suggestion;
  bg.onDeterminingFilename(
    { url, byExtensionId: bg.chrome.runtime.id },
    (value) => { suggestion = value; }
  );
  assert.equal(suggestion.filename, "02.png");
});
