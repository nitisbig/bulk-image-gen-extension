# ChatGPT Bulk Image Generator

A Chrome/Edge (Manifest V3) extension that automates image generation on
**chatgpt.com**. Paste a list of prompts (one per line), click **Start**, and the
extension submits each prompt, waits for the image to finish, and downloads it
with an incremental filename: `01.png`, `02.png`, `03.png`, …

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder
   (`chatgpt extension`).
4. Open <https://chatgpt.com> and start (or open) a chat. A floating
   **Bulk Image Generator** panel appears at the top-right.

## Use

1. Paste your prompts into the box — **one prompt per line**. Blank lines are
   ignored. The panel shows the running count and a numbered preview
   (`01`, `02`, …).
2. (Optional) Open **Settings** to change:
   - **Folder** — subfolder inside your Downloads folder (default `chatgpt-bulk`).
   - **Prefix** — text placed before the number (e.g. `fox_` → `fox_01.png`).
   - **Start #** — first number (default `1`).
   - **Pad** — digits to zero-pad to (default `2` → `01`; `3` → `001`).
   - **Delay (ms)** — pause between prompts.
   - **Timeout (ms)** — max time to wait for one image before giving up.
   - **Skip failed prompts** — continue past a timeout/error instead of stopping.
3. **Auto-download images** (checkbox above the buttons) — leave it **checked** to
   save each image; **uncheck** it to only generate the images in the chat
   without downloading anything.
4. Click **Start**. Each row updates its status: `typing → generating → saving →
   done` (or `generating → generated` when auto-download is off). Use
   **Pause/Resume** or **Stop** at any time. After a Stop you can **Resume
   queue** from where it left off.

**Resize / move the panel:** drag the **header** to move it; drag the
**bottom-right corner** to resize it. Click **–** to collapse/expand.

Files download to your normal Downloads directory (Chrome does not allow
extensions to write elsewhere), under the folder you set.

## How it works

- `manifest.json` — MV3 config; content script runs only on `chatgpt.com` /
  `chat.openai.com`; requests `downloads` + `storage` permissions.
- `content.js` — injects the panel (in a Shadow DOM so page CSS can't interfere),
  parses prompts, types each into the composer, submits it, watches the DOM until
  the generated image is present and its source has been stable for ~1.5s, then
  triggers the download.
- `background.js` — a service worker that performs `chrome.downloads.download()`
  with the custom filename (content scripts can't call that API directly).
- `panel.css` — panel styling.

## If ChatGPT changes its markup

All the site-specific bits are isolated:

- **Selectors** live in the `SELECTORS` object at the top of `content.js`
  (composer input, send button, stop button, assistant message container). Each
  is a list tried in order — add a new selector to the front if the UI changes.
- **Image detection** is `findGeneratedImages()` in `content.js`. It matches
  `<img>` elements inside assistant messages whose source looks like a generated
  image (`oaiusercontent` / `blob:` / `files.`) and that are at least 128px.
- **Completion detection** is `waitForNewImage()` — it waits for a new image
  beyond those present before submitting, requires the "stop generating" control
  to be gone, and requires the image source to hold steady (`stableMs`).

## Notes & limits

- Assumes **one image per prompt** (current ChatGPT behavior). If a prompt yields
  multiple images, only the last finished one is downloaded.
- Generate responsibly and within OpenAI's usage limits. Very fast automated
  submissions can hit rate limits; the **Delay** setting helps.
- Chromium only (uses MV3 + `chrome.*`). A Firefox port would mainly need a
  manifest tweak.
- This is an unofficial tool and not affiliated with OpenAI.
