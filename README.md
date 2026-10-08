<div align="center">

<img src="veil-banner.gif" alt="Veil — cinematic video backdrop" width="900">

# Veil

### A cinematic video backdrop for YouTube

Turn the currently playing YouTube video into a full-page ambient backdrop while keeping the YouTube player and controls fully usable.

<br>

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge\&logo=googlechrome\&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-5C5C5C?style=for-the-badge)
![Version](https://img.shields.io/badge/Version-1.0-8A2BE2?style=for-the-badge)

</div>

---

## ✨ Overview

**Veil** transforms the currently playing YouTube video into a subtle, full-page video backdrop.

Instead of leaving the area around the YouTube player as a static page background, Veil extends the visual atmosphere of the video across the page while keeping YouTube's interface above it.

The goal is simple:

> **Let the video become the atmosphere.**

---

## 🎬 Features

|     | Feature              | Description                                                         |
| :-: | -------------------- | ------------------------------------------------------------------- |
|  🎥 | **Video Backdrop**   | Uses the currently playing YouTube video as a full-page backdrop.   |
|  🔄 | **Video Switching**  | Follows YouTube video changes without requiring a page refresh.     |
| 🎛️ | **Player Toggle**    | Enable or disable Veil directly from the YouTube player controls.   |
| 🖥️ | **UI Preservation**  | Keeps the YouTube player and controls usable above the backdrop.    |
|  🌌 | **Ambient Mode**     | Designed to coexist with YouTube's native Ambient Mode.             |
|  💾 | **Local Preference** | Stores the Veil enabled/disabled state locally in Chrome.           |
|  ⚡  | **Lightweight**      | No external backend, analytics, account system, or third-party API. |

---

## 🧩 How It Works

Veil runs as a Chrome content script on YouTube watch pages.

```text
┌───────────────────────────────┐
│       Currently Playing       │
│        YouTube Video          │
└───────────────┬───────────────┘
                │
                │ captureStream()
                ▼
┌───────────────────────────────┐
│        Veil Backdrop          │
│      Full-page video layer    │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│       YouTube Interface       │
│   Player · Controls · UI      │
└───────────────────────────────┘
```

At a high level, Veil:

1. Detects the active YouTube `<video>` element.
2. Captures its media stream using `captureStream()`.
3. Creates a separate muted `<video>` element for the backdrop.
4. Places the backdrop beneath the relevant YouTube interface layers.
5. Monitors YouTube's dynamic page and video changes.
6. Reconnects the backdrop when the active video changes.

The video stream is processed locally in the browser.

---

## 🛠️ Built With

* **JavaScript**
* **Chrome Extensions**
* **Manifest V3**
* **`captureStream()`**
* **`chrome.storage.local`**
* **DOM APIs**
* **MutationObserver**

---

## 📁 Project Structure

```text
Veil/
│
├── manifest.json
├── content.js
├── veil-banner.gif
│
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Installation

Veil can currently be loaded manually as an unpacked Chrome extension.

### 1. Download the repository

Download or clone this repository.

### 2. Open Chrome Extensions

Navigate to:

```text
chrome://extensions
```

### 3. Enable Developer Mode

Turn on **Developer mode** in the top-right corner.

### 4. Load Veil

Click **Load unpacked** and select the project folder containing:

```text
manifest.json
```

### 5. Open YouTube

Open a YouTube video and use the **Veil toggle** in the player controls.

---

## 🔒 Privacy

Veil does not use an external backend or analytics service.

The extension:

* Does not require an account.
* Does not send the captured video stream to a Veil server.
* Does not use a third-party API.
* Stores the enable/disable preference using Chrome's local storage.

The active YouTube video is processed locally by the browser.

---

## 📌 Current Status

### Veil v1.0

The current version focuses on a reliable core experience:

* ✅ Full-page video backdrop
* ✅ Video switching
* ✅ YouTube UI layering
* ✅ Ambient Mode coexistence
* ✅ Player-integrated toggle
* ✅ Local preference storage

---

## 🗺️ Future Development

Possible future improvements include:

* Performance optimizations
* Additional player-state handling
* Fullscreen and theater-mode refinements
* Improved lifecycle and resource management
* Additional user controls

---

## ⚠️ Disclaimer

Veil is an independent project and is **not affiliated with, sponsored by, or endorsed by YouTube or Google**.

YouTube's interface and internal behavior may change over time, which may require compatibility updates.

---

<div align="center">

### Veil

**Let the video become the atmosphere.**

</div>
