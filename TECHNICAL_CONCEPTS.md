# CacheTray v1.4.2 — Technical Concepts Deep Dive

> This document covers every major technical concept in the CacheTray codebase.
> Goal: if an interviewer asks "how does X work?", you have a precise, confident answer.

---

## Table of Contents

1. [What Is CacheTray? The Problem It Solves](#1-what-is-cachetray-the-problem-it-solves)
2. [Tech Stack and Why Each Choice Was Made](#2-tech-stack-and-why-each-choice-was-made)
3. [Chrome Extension Architecture (The Big Picture)](#3-chrome-extension-architecture-the-big-picture)
4. [Manifest V3 — What It Is and Why It Matters](#4-manifest-v3--what-it-is-and-why-it-matters)
5. [The Five Files That Run the Extension](#5-the-five-files-that-run-the-extension)
6. [How Data Is Stored (Three Storage Systems)](#6-how-data-is-stored-three-storage-systems)
7. [How Clipboard Capture Works End-to-End](#7-how-clipboard-capture-works-end-to-end)
8. [Content Type Detection — How the App Knows if Something Is Code, a Link, or Text](#8-content-type-detection--how-the-app-knows-if-something-is-code-a-link-or-text)
9. [Image Compression — How and Why](#9-image-compression--how-and-why)
10. [Deduplication — Preventing Duplicate Captures](#10-deduplication--preventing-duplicate-captures)
11. [Search and Fuzzy Ranking](#11-search-and-fuzzy-ranking)
12. [AI Tab Injection — Sending Content to Claude and ChatGPT](#12-ai-tab-injection--sending-content-to-claude-and-chatgpt)
13. [The Focus Spoofing Trick](#13-the-focus-spoofing-trick)
14. [The Offscreen Document Pattern](#14-the-offscreen-document-pattern)
15. [The UI Rendering System](#15-the-ui-rendering-system)
16. [Theme System](#16-theme-system)
17. [Workspace and Cluster System](#17-workspace-and-cluster-system)
18. [Undo System](#18-undo-system)
19. [Security and Privacy Design](#19-security-and-privacy-design)
20. [Key Numbers and Design Decisions](#20-key-numbers-and-design-decisions)
21. [Common Interview Questions and Strong Answers](#21-common-interview-questions-and-strong-answers)

---

## 1. What Is CacheTray? The Problem It Solves

**CacheTray** is a Chrome browser extension — a small program that runs inside your browser and adds new functionality to it.

### The Problem

When developers, writers, or researchers use AI tools like Claude or ChatGPT, they constantly:
- Find a code snippet on Stack Overflow → copy it → switch to ChatGPT tab → paste it
- Take a screenshot → download it → drag it into Claude
- Copy five different pieces of text from five different tabs and try to remember them all

This is **context switching friction** — your brain and your hands are wasted doing busywork instead of thinking.

### The Solution

CacheTray acts like a **smart clipboard tray in your browser sidebar**. It:
1. Automatically captures everything you copy — text, links, code, screenshots
2. Organizes it into workspaces
3. Lets you send items directly into Claude or ChatGPT with one click — no file downloads, no manual pasting

Think of it like a sticky-notes board that lives in your browser and can magically type itself into an AI chat window.

---

## 2. Tech Stack and Why Each Choice Was Made

| Technology | What It Is | Why It Was Used |
|---|---|---|
| **Vanilla JavaScript** | Plain JS, no framework | Zero dependencies = smaller extension, faster load, no supply-chain risk |
| **HTML + CSS** | Markup and styling | Direct DOM control, no virtual DOM overhead |
| **Chrome Extensions API (MV3)** | Browser's official API for extensions | Required to interact with tabs, clipboard, storage |
| **IndexedDB** | Browser's built-in database | Stores large binary image data that Chrome Storage can't handle |
| **Chrome Storage API** | Key-value store built into Chrome | Fast, reliable storage for small metadata (text notes, settings) |
| **Canvas API** | Browser's drawing surface | Used to resize and compress images without any library |
| **Clipboard API** | Web API for reading/writing clipboard | Captures what the user copies |
| **Web Share API** | Browser native share dialog | Share items to any app (email, notes, etc.) without custom code |

### Why No Framework (React, Vue, etc.)?

This is a common interview question. The answer here is:
- Extensions load in constrained environments — a React bundle would add 100KB+ overhead
- There's no server, no build pipeline — keeping it vanilla means anyone can open the folder and understand it immediately
- The UI is simple enough that a framework would add complexity, not remove it
- **Maintainability tradeoff:** vanilla JS means you write more DOM code by hand, but you never fight framework quirks

---

## 3. Chrome Extension Architecture (The Big Picture)

A Chrome extension is not a single program. It's actually **multiple separate programs** that run in isolated JavaScript environments (called "worlds" or "contexts") and communicate by passing messages to each other.

```
┌─────────────────────────────────────────────────────────────────┐
│                        CHROME BROWSER                            │
│                                                                   │
│  ┌─────────────────────┐     ┌──────────────────────────────┐   │
│  │   background.js     │     │  popup.js / sidebar.js (UI)  │   │
│  │   (Service Worker)  │◄────►  Shown when user clicks icon  │   │
│  │   Always running    │     │  Renders the notes list       │   │
│  └────────┬────────────┘     └──────────────────────────────┘   │
│           │                                                        │
│           │  chrome.tabs.sendMessage()                             │
│           │                                                        │
│  ┌────────▼────────────────────────────────────────────────────┐  │
│  │                   OPEN WEB PAGE (e.g. github.com)           │  │
│  │  ┌────────────────────────────┐  ┌──────────────────────┐  │  │
│  │  │   content-script.js        │  │   injected.js        │  │  │
│  │  │   (ISOLATED world)         │  │   (MAIN world)       │  │  │
│  │  │   Reads page events        │  │   Patches clipboard  │  │  │
│  │  │   Bridges to background    │  │   API on the page    │  │  │
│  │  └────────────────────────────┘  └──────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │   offscreen.js (Offscreen Document)                          │  │
│  │   Hidden background page with clipboard read access          │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### The Isolation Problem

Each context can't directly call functions in another context. They're like separate rooms. To communicate, they pass **messages** — serialized JSON objects sent over a message bus.

- `chrome.runtime.sendMessage()` — sends a message to any extension context
- `chrome.tabs.sendMessage(tabId, message)` — sends a message to a specific tab's content script
- `window.postMessage()` — sends a message between page scripts (injected.js → content-script.js)

This message-passing architecture is not unique to Chrome extensions — it's the same model used in web workers, React Native bridges, and microservices.

---

## 4. Manifest V3 — What It Is and Why It Matters

**Manifest V3 (MV3)** is the current version of Chrome's extension platform rules. The `manifest.json` file is the extension's "ID card" — it tells Chrome what the extension is, what it's allowed to do, and which files run where.

### Why MV3 Is Harder to Work With

Before MV3, extensions could run a permanent background page that had full access to everything. MV3 replaced this with a **Service Worker** — a background script that Chrome can terminate at any time to save memory. This creates real engineering challenges:

1. **No persistent memory** — the service worker can be killed mid-operation, so any in-memory state is lost
2. **No clipboard access** — the service worker has no DOM, so it can't use clipboard APIs
3. **Stricter permissions** — many APIs that were previously unrestricted now require explicit permission declarations

CacheTray has clever solutions for all three of these, which is what makes this codebase technically interesting.

### Key Permissions in manifest.json

```json
"permissions": [
  "storage",       // Read/write chrome.storage
  "contextMenus",  // Right-click menu
  "activeTab",     // Access the current tab
  "scripting",     // Inject JavaScript into pages
  "offscreen",     // Create hidden pages for clipboard access
  "clipboardRead", // Read clipboard contents
  "clipboardWrite",// Write to clipboard
  "sidePanel"      // Open as browser sidebar
]
```

Each permission declaration is a security boundary — Chrome shows users what data an extension can access before they install it. Requesting only what you need is both a security best practice and required for Chrome Web Store review.

---

## 5. The Five Files That Run the Extension

### `background.js` — The Central Hub (791 lines)

**What it is:** A Service Worker — a JavaScript file that runs in the background even when the popup is closed. Think of it as the extension's backend.

**What it does:**
- Receives messages from all other parts of the extension
- Decides whether to save new captured content
- Manages storage reads and writes
- Creates and destroys the offscreen document
- Listens for Claude/ChatGPT tab openings to inject content
- Handles context menu (right-click) captures

**Why it's the hub:** Every other context is ephemeral (can be opened and closed). The service worker is the only always-on context that can coordinate between them.

### `popup.js` — The UI Brain (2,382 lines)

**What it is:** The JavaScript that powers the popup window and sidebar UI.

**What it does:**
- Loads all saved notes from storage and renders them as a list
- Handles user interactions: clicking, selecting, deleting, favoriting, searching
- Manages workspaces (clusters) and categories
- Provides bulk operations: copy all, send to AI, download, share
- Runs its own paste listener for when the user pastes directly into the popup

**Why it's the largest file:** The UI has the most surface area — search, filtering, rendering, drag-to-select, image preview, themes, undo, onboarding. All of this is written in plain DOM manipulation code.

### `content-script.js` — The Page Spy (529 lines)

**What it is:** A script that Chrome injects into every webpage the user visits.

**What it does:**
- Listens for clipboard events on the page
- Receives clipboard data from `injected.js` via `window.postMessage`
- Deduplicates clipboard reads before forwarding to background
- Shows a toast notification on the page when something is captured
- Receives `INSERT_ITEMS` messages from background and pastes content into the active editor on the page

**Why it's isolated:** Content scripts run in an "isolated world" — they can see the page's DOM but share no JavaScript scope with the page. This prevents malicious page code from accessing extension APIs.

### `offscreen.js` — The Clipboard Reader (179 lines)

**What it is:** A hidden HTML page created by the background service worker specifically to read clipboard contents.

**Why it exists:** In MV3, the service worker has no DOM access, so it cannot call `navigator.clipboard.read()`. The offscreen document solves this — it's a real (though hidden) page that has DOM access and therefore clipboard access.

**What it does:**
- Receives `READ_CLIPBOARD` messages from background
- Calls `navigator.clipboard.read()` to get the current clipboard content
- Returns the data (text string or image data URL) back to background via message

### `injected.js` — The Clipboard Hook (97 lines)

**What it is:** A script injected into the page's MAIN JavaScript world — meaning it actually runs as part of the page, not as an isolated extension.

**What it does:**
- Wraps `navigator.clipboard.writeText()` and `navigator.clipboard.write()` so it can intercept every time a page programmatically copies something (e.g., "Copy Code" button on GitHub)
- Converts image blobs to base64 data URLs (because you can't pass binary data through `window.postMessage`)
- Posts the captured data to `content-script.js` via `window.postMessage`

**Why MAIN world injection is necessary:** Only code running in the page's own JavaScript context can monkey-patch (override) the page's native `navigator.clipboard`. The extension's isolated world can't touch the page's clipboard object.

---

## 6. How Data Is Stored (Three Storage Systems)

CacheTray uses **three separate storage systems** for different types of data. Understanding why is a good interview talking point.

### System 1: `chrome.storage.local` — The Metadata Store

**What goes here:** Everything except image binary data — the list of workspaces, note text, URLs, timestamps, favorites, settings, theme.

**Why not localStorage?** `localStorage` is per-origin (per website). `chrome.storage.local` is per-extension and accessible from all extension contexts (background, popup, content scripts).

**Data shape:**
```json
{
  "quicknotes_v1": {
    "clusters": [
      {
        "id": "abc123",
        "label": "My Workspace",
        "notes": [
          {
            "id": "note_1",
            "type": "code",
            "content": "const x = 1;",
            "ts": 1715000000000,
            "favorited": false,
            "imageId": null
          }
        ]
      }
    ]
  }
}
```

**10MB limit:** Chrome's `storage.local` has a 10MB limit. The code guards against this by checking if serialized data exceeds 9MB and auto-pruning the oldest images first.

### System 2: IndexedDB — The Image Store

**What goes here:** Raw compressed image blobs (binary data).

**Why not chrome.storage?** Images are large — a single screenshot can be 500KB. Storing them as base64 strings in `chrome.storage` would bloat the 10MB quota fast and also slow down every read/write of the metadata (because the whole object would be bigger).

**How it works:** When an image is saved, the binary blob is stored in IndexedDB and given a numeric ID. That ID is saved in the note's metadata as `imageId`. When rendering, the UI fetches the blob from IndexedDB using that ID and creates an object URL (`URL.createObjectURL(blob)`) to display it.

**Cache layer:** `imgObjectUrlCache` is a `Map` that stores already-created object URLs so the same blob isn't re-fetched from IndexedDB on every re-render. Object URLs are like temporary file paths — they only exist in memory for that browser session.

### System 3: `chrome.storage.session` — The AI Staging Area

**What goes here:** Items that are "staged" to be injected into Claude or ChatGPT. This is written by the popup and read by the background service worker when it detects the AI tab opening.

**Why session storage?** Session storage is automatically cleared when the browser closes. This is the right behavior for a staging area — you don't want half-sent items to linger permanently.

---

## 7. How Clipboard Capture Works End-to-End

This is the most architecturally complex part of the system. There are actually **three parallel capture paths**, each designed for a different scenario.

### Path A: Programmatic Copy (e.g., "Copy Code" button on GitHub)

```
GitHub page JS calls navigator.clipboard.writeText("some code")
        ↓
injected.js has wrapped this function, so it intercepts the call
        ↓
injected.js calls window.postMessage({ type: 'quicknotes-capture-copy', text: '...' })
        ↓
content-script.js receives the postMessage
        ↓
Dedup check: is this the same as the last thing stored? If yes, skip
        ↓
content-script.js calls chrome.runtime.sendMessage({ type: 'COPIED_TEXT', text: '...' })
        ↓
background.js receives the message → calls addStoredNote()
        ↓
Type detection (code/link/text) → dedup check → save to chrome.storage.local
        ↓
Shows toast notification on the page (via content-script)
```

### Path B: User Presses Ctrl+C (Keyboard Copy)

```
User presses Ctrl+C on a webpage
        ↓
content-script.js listens for the 'copy' event on the document
        ↓
Waits 180ms (debounce) — because the clipboard write is async
        ↓
Asks background: "check clipboard for image" (CHECK_CLIPBOARD_IMAGE message)
        ↓
background.js asks offscreen.js to read the clipboard
        ↓
offscreen.js calls navigator.clipboard.read() → returns text or image
        ↓
background.js stores the result via addStoredNote()
```

### Path C: Clipboard Polling (Fallback)

```
Every 2.5 seconds:
        ↓
offscreen.js polls the clipboard (pollClipboard function)
        ↓
Compares to last known clipboard content
        ↓
If changed → sends NEW_CLIPBOARD_CONTENT message to background
        ↓
background.js deduplicates and stores if new
```

**Why three paths?** Each covers a gap:
- Path A catches programmatic copies that don't fire a DOM `copy` event
- Path B catches user key presses immediately
- Path C catches edge cases (browser-native copy, copy from address bar, etc.)

**Why the 7-second image capture pause?** When the user manually copies an image, both Path B AND Path C might detect it. The 7-second pause after an image capture prevents the same image from being stored twice.

---

## 8. Content Type Detection — How the App Knows if Something Is Code, a Link, or Text

Every captured piece of text goes through `detectType(text)`, which returns `'code'`, `'link'`, or `'text'`.

### URL Detection (`looksLikeUrl`)

**Step 1:** Does it start with a URL scheme? (`http://`, `https://`, `git://`, `ftp://`, etc.)
→ If yes → it's a URL

**Step 2:** Does it contain whitespace?
→ If yes → can't be a URL (URLs have no spaces)

**Step 3:** Does it look like a domain? (`www.something` or `name.tld`)
→ If yes → try `new URL('https://' + text)` — if it parses without error, it's a URL

The `new URL()` constructor is used as a validator because URL parsing is complex. Instead of writing regex for every edge case, the code delegates to the browser's built-in URL parser.

### Code Detection (`looksLikeCode`)

**Stage 1 — Strong single-line signals (17 patterns):**
If ANY of these match the first line, it's immediately classified as code:

| Pattern | Example |
|---|---|
| ` ```  ` | Start of a code fence block |
| `$ ` at start | Shell command prompt |
| `npm `, `npx `, `git `, `pip ` | Package manager commands |
| `const`, `let`, `var` | JavaScript variable declarations |
| `function` | Function declaration |
| `class ` | Class declaration |
| `import ... from` | ES module import |
| `export` | ES module export |
| `=>` | Arrow function |
| `<` at start | HTML tag |
| `//`, `#`, `/*` | Comments |

**Stage 2 — Multi-line heuristic (if Stage 1 didn't match):**

For text with 2+ lines, the code counts:
- **Indented lines:** lines starting with 2+ spaces
- **Code keywords:** `if`, `for`, `while`, `return`, `def`, `class`, `function`, etc.
- **Brace-only lines:** lines that are just `{` or `}`

Decision rule:
```
if (indented_lines >= 3 AND brace_lines >= 1) → code
OR (keyword_count >= 2) → code
OR (text contains ```) → code
```

**Why heuristics instead of a real parser?** Running a language parser for every clipboard capture would be too slow. Heuristics cover 95%+ of real-world cases in microseconds.

---

## 9. Image Compression — How and Why

### The Problem

A 1920×1080 screenshot in PNG format can be 2–5MB. Storing many of these would instantly exceed the 10MB storage quota. The solution is to compress images before storing them.

### The Canvas API Approach

```javascript
// 1. Load the image into a bitmap (decoded pixel data)
const bitmap = await createImageBitmap(blob)

// 2. Calculate new dimensions (scale down if too big)
const maxDimension = 1920
let { width, height } = bitmap
if (width > maxDimension || height > maxDimension) {
  const scale = maxDimension / Math.max(width, height)
  width = Math.round(width * scale)
  height = Math.round(height * scale)
}

// 3. Draw onto an offscreen canvas at the new size
const canvas = new OffscreenCanvas(width, height)
canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)

// 4. Export as a compressed format
// Screenshots (PNG) → WebP at 92% quality (WebP is ~70% smaller than PNG)
// Photos (JPEG/WebP) → JPEG at 88% quality (photos don't benefit from WebP lossless)
const compressed = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
```

**Why WebP for screenshots?** WebP uses better compression algorithms than PNG and supports both lossless and lossy compression. A PNG screenshot converted to WebP 92% quality is typically 60-70% smaller with no visible quality loss.

**Why JPEG for photos?** Photos already have complex gradients that WebP's lossless mode doesn't help. JPEG at 88% quality is a well-known sweet spot between size and fidelity.

**Why `OffscreenCanvas` in the background, `Canvas` in popup?** Service workers don't have a DOM, so you can't use `document.createElement('canvas')`. `OffscreenCanvas` is the DOM-free version that works in workers.

---

## 10. Deduplication — Preventing Duplicate Captures

Because clipboard polling runs every 2.5 seconds, the same content would be captured over and over without deduplication. This is solved at multiple levels.

### Level 1: Content Script Dedup (Fast Path)

`content-script.js` keeps track of `lastStoredTextKey` and `lastStoredImageHash`. Before sending a message to background, it checks if the new content is the same as the last thing it sent. If it is, the message is dropped immediately.

This is the fastest check — no storage I/O, no async operations.

### Level 2: Background Storage Dedup

When `addStoredNote()` is called, it runs `findDuplicateNote()` which searches all existing notes across all workspaces:

```javascript
function noteComparisonKey(note) {
  if (note.type === 'image') {
    // For images: use length + first 120 chars + last 120 chars of data URL
    // (Checking the entire data URL would be too slow)
    return `img:${note.content.length}:${note.content.slice(0, 120)}:${note.content.slice(-120)}`
  }
  // For text: normalize whitespace so "hello  world" === "hello world"
  return note.content.replace(/\s+/g, ' ').trim()
}
```

**What happens on a duplicate?** Instead of creating a new note (which would create clutter), the existing note's timestamp is bumped to now and it moves to the top of the list. This behavior is called "re-promoting" — it's surfacing the thing you keep coming back to.

### Level 3: The 7-Second Image Pause

After any image is copied to the clipboard (either by the user or the extension), `imageCapturesPausedUntil` is set to `Date.now() + 7000`. For 7 seconds, all image captures are ignored. This prevents the case where Path B and Path C both try to save the same screenshot simultaneously.

---

## 11. Search and Fuzzy Ranking

When the user types in the search box, notes are filtered and ranked by relevance — not just filtered by exact match.

### How Scoring Works

Each word in the search query is scored against each note's content using `scoreWord()`:

| Match Type | Score | Example (searching "react") |
|---|---|---|
| Word at the start of content | 4 | "react hooks tutorial" |
| Word after a separator (space, `-`, `_`, `.`, `/`) | 3 | "intro-to-react" |
| Word appears anywhere inside content | 2 | "areacting to change" |
| Word not found | 0 | (note is excluded) |

For multi-word queries, all words must match (if any word scores 0, the note is excluded). The total score across all words determines ranking order.

**After scoring, notes are sorted by:**
1. Total relevance score (descending)
2. Timestamp (descending) — newer items win ties

### Type Prefix Filters

The search parser checks for hashtag prefixes:
- `#code` → show only code items
- `#image` → show only images
- `#link` → show only links
- `#text` → show only text

These are stripped before scoring, so `#code react hooks` searches for "react hooks" within code items only.

### Match Highlighting

After filtering, the matching portions of text are highlighted using DOM text node manipulation — not string replacement with HTML (which would be an XSS risk). The code walks the text nodes in each row element and wraps matching ranges in `<mark>` elements.

---

## 12. AI Tab Injection — Sending Content to Claude and ChatGPT

This is the flagship feature. When you click "Send to Claude", the following happens:

### Step 1: Staging

The popup writes the selected items into `chrome.storage.session` under the key `ct_pending_ai`:

```javascript
await chrome.storage.session.set({
  ct_pending_ai: {
    destination: 'claude', // or 'chatgpt'
    items: [ /* array of note objects */ ],
    ts: Date.now()
  }
})
```

### Step 2: Tab Opening

The popup calls `chrome.tabs.create({ url: 'https://claude.ai/new' })` to open Claude in a new tab.

### Step 3: Detection in Background

`background.js` listens to `chrome.tabs.onUpdated` — an event that fires whenever any tab changes state (loading, complete, etc.). When a Claude or ChatGPT tab reaches the `"complete"` state:

```javascript
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isAiTab(tab.url)) {
    const pending = await chrome.storage.session.get('ct_pending_ai')
    if (pending.ct_pending_ai) {
      injectItemsIntoTab(tabId, pending.ct_pending_ai.items)
      chrome.storage.session.remove('ct_pending_ai')
    }
  }
})
```

### Step 4: Content Injection

For text items, background sends an `INSERT_ITEMS` message to the tab's content script, which finds the active editor element and sets its content.

For images, the approach is more complex — see the next section.

---

## 13. The Focus Spoofing Trick

### The Problem

Claude uses **ProseMirror** and ChatGPT uses **Lexical** — these are rich text editor frameworks. Both frameworks check `document.hasFocus()` before accepting synthetic paste events. If the document doesn't "think" it's focused, the paste is silently ignored.

When background.js triggers injection, the Claude tab may not be the active window, so `document.hasFocus()` returns `false`.

### The Solution: Patching `document.hasFocus`

```javascript
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN', // Must be MAIN world to patch the real DOM
  func: async (imageList) => {
    const el = document.querySelector('[contenteditable]')
    el.focus()
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    // Temporarily lie to the editor framework
    const origProto = Document.prototype.hasFocus
    Document.prototype.hasFocus = () => true
    Object.defineProperty(document, 'hasFocus', {
      value: () => true,
      configurable: true,
      writable: true
    })

    // Create and dispatch a synthetic paste event with the image
    for (const imageData of imageList) {
      const file = new File([blob], 'image.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }))
      await new Promise(r => setTimeout(r, 150)) // Small delay between images
    }

    // Restore original behavior
    Document.prototype.hasFocus = origProto
  },
  args: [imageList]
})
```

**Why MAIN world for `executeScript`?** The extension's injected scripts normally run in an isolated world. But to patch the prototype of `Document` (the real one that ProseMirror checks), you need to be in the same JavaScript scope as the page — the MAIN world.

**Why patch the prototype, not just the instance?** ProseMirror calls `document.hasFocus()`, which goes through `Document.prototype.hasFocus`. Patching just `document.hasFocus` (the own property) might be caught by the framework's internal checks. Patching the prototype ensures all calls are intercepted.

**Why restore it?** Leaving `hasFocus` permanently broken would break the editor's normal behavior after the injection. Always clean up patches.

---

## 14. The Offscreen Document Pattern

### The Problem in MV3

Service workers (background.js) are headless — they have no DOM, no window, no clipboard access. But reading the clipboard requires `navigator.clipboard.read()`, which requires a page context.

### The Solution

MV3 introduced the **Offscreen Document API** for exactly this use case. You can create a hidden HTML page that has full DOM access but no visible UI.

```javascript
// background.js
async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.getContexts({ documentUrl: chrome.runtime.getURL('offscreen.html') })
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'], // Must declare why you need it
      justification: 'Read clipboard contents for capture feature'
    })
  }
}
```

The `reasons` field is important — Chrome limits what an offscreen document can do based on the declared reason. `CLIPBOARD` allows clipboard access.

```javascript
// offscreen.js
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'READ_CLIPBOARD') {
    const items = await navigator.clipboard.read()
    // Process and return data
    const result = await processClipboardItems(items)
    return result
  }
})
```

**Concurrency lock:** `activeReadPromise` prevents two simultaneous clipboard reads, which would cause race conditions. The second caller waits for the first to finish.

---

## 15. The UI Rendering System

The popup's UI is rebuilt from scratch on every meaningful state change. This is called **imperative rendering** — as opposed to React's declarative model.

### Render Flow

```
renderAll()
  ├── renderTabs()     → DOM for workspace tabs at top
  ├── renderCats()     → DOM for category filter buttons (All / Code / Link / Text / Image)
  └── renderFeed()     → DOM for the main list of notes
        ├── if search query active → filter + score + sort → renderFilteredFeed()
        └── else → filter by category → sort by favorite then timestamp → renderNormalFeed()
```

### `buildRow(note)` — The Core Render Function

Every note in the list is rendered by `buildRow()`, which creates a DOM element and populates it based on the note's type:

- **Text notes:** Simple content div with expandable overflow
- **Code notes:** Syntax-highlighted `<pre><code>` block, collapsible
- **Link notes:** Clickable URL with favicon, domain label, and description
- **Image notes:** Thumbnail with aspect-ratio preservation, expand on click

The row includes inline action buttons: copy, favorite (star), delete. For images, additional buttons for downloading and sharing are added.

### Selection System

`selectedIds` is a JavaScript `Set` — a data structure that stores unique values. When the user clicks a checkbox or shift-clicks to range-select:

```javascript
selectedIds.add(noteId)   // Select
selectedIds.delete(noteId) // Deselect
selectedIds.clear()       // Deselect all
```

Using a `Set` instead of an array means `has()`, `add()`, and `delete()` are all O(1) operations — they take the same time regardless of how many items are selected.

---

## 16. Theme System

### CSS Variables

The theme system uses CSS custom properties (variables), defined on `:root` or `html`:

```css
html.dark {
  --bg: #1a1f2e;
  --text: #e0e6f0;
  --accent: #4a9eff;
}

html.light {
  --bg: #f5f5f0;
  --text: #2d3748;
  --accent: #2d7a4f;
}
```

Every color in the entire CSS file references these variables instead of hard-coded values. Switching themes is then just toggling a class on the `<html>` element — no JavaScript color calculations needed.

### `theme-boot.js` — Why It Exists

`theme-boot.js` is a 5-line script that runs before anything else:

```javascript
const saved = localStorage.getItem('ct_theme') || 'dark'
document.documentElement.classList.add(saved)
```

Without this, the popup would flash the wrong theme for a fraction of a second before `popup.js` initializes and applies the correct theme. This "flash of incorrect theme" is a common UI problem solved by injecting theme class as early as possible — before the rest of the page renders.

**Why `localStorage` instead of `chrome.storage`?** `chrome.storage` is async. Reading from it would require an `await`, which means the theme would always be applied late. `localStorage` is synchronous, making it suitable for this early-boot pattern.

---

## 17. Workspace and Cluster System

### Data Model

A **cluster** is a workspace (a named tab at the top of the UI). Each cluster contains an array of **notes** (captured items).

```javascript
{
  id: "cluster_abc123",
  label: "My Research",
  color: "#4a9eff",
  notes: [
    { id: "note_1", type: "code", content: "...", ts: 1715000000000, favorited: false },
    { id: "note_2", type: "link", content: "https://...", url: "...", ts: 1715000001000 }
  ]
}
```

### CAT_LIMIT and Overflow Handling

Each workspace has a limit of 10,000 items per type (`CAT_LIMIT = 10000`). If a workspace is full, instead of silently dropping new captures, the system auto-creates a new overflow workspace ("workspace 2", "workspace 3", etc.) and continues saving there.

This is a graceful degradation strategy — the user never loses data, they just get a new workspace automatically. The overflow workspace gets the same color as the original to visually communicate the relationship.

---

## 18. Undo System

### Simple but Effective

When a note is deleted, it's not immediately gone:

```javascript
// On delete:
lastDel = {
  note: { ...deletedNote },  // Copy of the note
  clusterId: currentClusterId,
  index: originalIndex        // Where in the list it was
}
```

The UI shows an undo bar with a 5-second timer (animated progress bar using CSS transitions). If the user clicks Undo:

```javascript
function undoDelete() {
  const cluster = findClusterById(lastDel.clusterId)
  cluster.notes.splice(lastDel.index, 0, lastDel.note) // Re-insert at original position
  saveData()
  renderAll()
  lastDel = null
}
```

`Array.splice(index, 0, item)` inserts `item` at `index` without removing anything. This is how the note is re-inserted exactly where it was.

**Why a timer?** The undo bar auto-hides after 5 seconds because users expect short undo windows (this matches Google's Material Design guidelines for snackbars). After 5 seconds, `lastDel` is cleared.

---

## 19. Security and Privacy Design

### No Network Calls — Ever

The extension makes zero requests to any server. There is no analytics, no telemetry, no remote logging. All data stays in the user's browser profile on their local machine.

### XSS Prevention

When rendering note content into the DOM, the code uses `textContent` (not `innerHTML`) for user-generated text. This prevents cross-site scripting — if a captured note contains `<script>alert('xss')</script>`, it renders as literal text, not as executed HTML.

Only specifically constructed, safe HTML (like the action buttons) is set via `innerHTML`, and that HTML is built by the extension's own code, never from user input.

### Auto-Expiry

Notes older than 3 days are automatically deleted:
```javascript
const EXPIRY_MS = 3 * 24 * 60 * 60 * 1000 // 3 days in milliseconds
notes = notes.filter(note => Date.now() - note.ts < EXPIRY_MS)
```

This is a privacy feature — stale clipboard data doesn't accumulate forever.

### Permission Scoping

Host permissions (`https://*/*`) are declared as **optional** and requested at runtime. This means the extension doesn't have blanket access to all websites by default — the user must explicitly grant it. This follows the principle of least privilege.

### Image Isolation

Images are stored in IndexedDB, separate from text metadata in `chrome.storage`. This means:
1. A metadata leak doesn't expose image contents
2. Images can be deleted independently of their metadata records

---

## 20. Key Numbers and Design Decisions

Understanding why specific numbers were chosen shows engineering maturity.

| Number | What It Is | Why This Value |
|---|---|---|
| **9MB** | Storage quota guard threshold | Chrome's hard limit is 10MB; 9MB leaves headroom for the surrounding data structures |
| **10,000** | Max items per type per workspace | Above this, rendering performance degrades noticeably in plain DOM manipulation |
| **1920px** | Max image dimension | Retina screens are 2x at 960px logical — 1920px covers high-DPI without waste |
| **92%** | WebP compression quality | Below 90% shows artifacts on text in screenshots; above 95% yields minimal size gain |
| **88%** | JPEG compression quality | Industry-standard "good quality" threshold for photos |
| **2.5s** | Clipboard poll interval | Responsive enough to feel instant; infrequent enough to not drain CPU |
| **7s** | Image capture pause duration | Enough time for the user to finish a multi-step copy action before next poll |
| **180ms** | Keystroke debounce for clipboard read | Below human perception threshold; above typical keystroke noise |
| **5s** | Undo window | Matches Material Design snackbar guidelines; matches user expectation |
| **3 days** | Note expiry | Long enough to be useful; short enough for privacy |
| **80ms** | Search debounce | Updates feel instant but don't re-render on every single character |
| **350ms** | Delay between bulk downloads | Avoids browser throttling multiple simultaneous downloads |
| **150ms** | Delay between image injections into AI | Gives the editor time to process each paste before the next arrives |

---

## 21. Common Interview Questions and Strong Answers

### "What does this project do?"

> CacheTray is a Chrome extension that acts as a clipboard manager for AI workflows. When you copy anything — code, links, text, screenshots — it automatically captures and organizes it in a sidebar. You can then send multiple captured items directly into Claude or ChatGPT with one click, which eliminates the repetitive copy-paste-switch-tab workflow that slows down anyone who uses AI tools.

### "What was the hardest technical problem?"

> The hardest problem was injecting images into Claude and ChatGPT reliably. Those apps use ProseMirror and Lexical — sophisticated rich text editors that reject synthetic paste events if `document.hasFocus()` returns false. Since we're injecting programmatically (not from a real user gesture), the document isn't focused. The solution was to execute a script in the page's MAIN JavaScript world, temporarily patch `Document.prototype.hasFocus` to return true, dispatch the synthetic paste event, then restore the original function. It's a surgical monkey-patch that works because editor frameworks check that prototype.

### "Why use IndexedDB for images instead of Chrome Storage?"

> Chrome's `storage.local` has a 10MB limit and stores everything as JSON. Images as base64 strings would be 33% larger than the raw binary, and storing them in the same JSON blob as all the text metadata means every read and write of any note would serialize and deserialize potentially megabytes of image data. IndexedDB is built for binary blobs — it stores them efficiently and lets you retrieve individual items by ID without touching anything else.

### "How do you prevent duplicates when polling the clipboard every 2.5 seconds?"

> There are three layers. First, the content script tracks the last thing it sent and drops any message that matches. Second, when the background actually goes to save, it computes a comparison key for the new item and scans all existing notes — if it finds a match, it bumps the timestamp and moves it to the top instead of creating a duplicate. Third, after any image is captured, a 7-second pause flag is set to prevent the poller from re-capturing the same image.

### "This has no build system. Is that a problem?"

> For a Chrome extension of this size, no. A build system like webpack adds complexity — configuration files, dependency trees, build steps that can break. Without one, the source files are exactly what Chrome runs, making debugging much easier (you see real file names and real line numbers in DevTools). The tradeoff is that there's no tree-shaking, no minification, no TypeScript. For a small, single-developer extension, that tradeoff makes sense. If the project grew significantly, adding a build step would be the right call.

### "How does the Offscreen Document solve MV3's clipboard limitation?"

> MV3 replaced persistent background pages with Service Workers, which don't have DOM access. Without a DOM, you can't call `navigator.clipboard.read()`. The Offscreen Document API lets you create a hidden page (with a real DOM) that can do clipboard reads on behalf of the service worker. The service worker sends a `READ_CLIPBOARD` message, the offscreen document reads the clipboard and sends the data back. It's basically a "proxy page" that exists solely to bypass the Service Worker's DOM restriction.

### "Walk me through what happens when I press Ctrl+C on a webpage."

> First, the content script detects the `copy` event on the document. It waits 180ms (debounce) for the clipboard write to complete, then sends a `CHECK_CLIPBOARD_IMAGE` message to the background service worker. The background ensures the offscreen document exists, then forwards a `READ_CLIPBOARD` request to it. The offscreen document calls `navigator.clipboard.read()`, gets the items, converts any images to data URLs, and returns the result. Background receives it, runs type detection (code vs link vs text), does a dedup check against stored notes, compresses any image data, stores the result in IndexedDB or chrome.storage.local, then tells the content script to show a toast notification on the page.

### "What would you change or improve about this codebase?"

> The biggest risk is `popup.js` at 2,382 lines — it does everything: storage, rendering, search, bulk operations, AI injection staging. If this were a team project, I'd split it into modules: a data layer, a rendering layer, and an event handler layer. I'd also add TypeScript for type safety — the data model (notes, clusters) has implicit shapes that TypeScript interfaces would make explicit and catch bugs at edit time. The search scoring algorithm is solid but could be improved with TF-IDF weighting for longer notes. And I'd add a service worker persistence strategy (like storing a heartbeat ping) to prevent Chrome from terminating it mid-clipboard-poll.

---

## Quick Reference: File Map

| File | Lines | Role |
|---|---|---|
| `manifest.json` | ~50 | Extension config, permissions, entry points |
| `background.js` | 791 | Service worker — hub for storage, capture, injection |
| `popup.js` | 2,382 | UI — rendering, search, bulk ops, workspace mgmt |
| `content-script.js` | 529 | Page bridge — captures clipboard events, shows toasts, handles paste insertion |
| `offscreen.js` | 179 | Clipboard reader — the only context that can call navigator.clipboard.read() |
| `injected.js` | 97 | Page-level clipboard API patcher (runs in MAIN world) |
| `theme-boot.js` | 5 | Early theme application to prevent flash of wrong theme |
| `popup.css` | 2,407 | All styles — CSS variables for theming, responsive layout |

---

*Document generated for CacheTray v1.4.2 — May 2026*
