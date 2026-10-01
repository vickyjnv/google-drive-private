# Drive Private Video Downloader Pro

A Google Chrome Extension (Manifest V3) designed to detect and download Google Drive videos directly—including private, restricted, and view-only shares—with verified multiplexed audio, in-page floating controls, and a modern popup interface.

---

## Key Features

- **Progressive Multiplexing Guarantee**: Prioritizes multiplexed formats (`itag 22` 720p HD / `itag 18` 360p SD) containing both video and audio in a single MP4 container, preventing silent/audio-less downloads.
- **Accurate Video Title Detection**: Resolves actual video filenames directly from Google Drive DOM elements (even when inside subfolders) rather than defaulting to parent folder names.
- **In-Page Floating Action Button (FAB)**: Automatically shows an interactive floating download button on Google Drive pages with a rich hover tooltip displaying file size, quality, and audio status.
- **Service Worker Reliability**: Leverages `chrome.storage.session` for state persistence across Manifest V3 service worker idle cycles.
- **Flicker-Free Popup UI**: Incorporates data hashing and DOM equality checks to eliminate re-render flickering.
- **Expanded Cyber-Glass Interface**: 480px responsive dashboard featuring live stream metrics, codec inspectors, one-click downloads, and engine status toggles.

---

## Installation

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the root folder of this project (`c:\Users\vicky\antigravity\google-drive-private`).
5. Open any Google Drive video.

---

## How to Use

### Method 1: In-Page Floating Button
1. Open or preview any video on Google Drive.
2. An emerald **Download** floating button will appear in the bottom-right corner.
3. Hover to preview video details (Title, Quality, Audio track verification, Size).
4. Click to download the MP4 file directly.

### Method 2: Extension Popup
1. Click the **Drive Video Pro** icon in the Chrome toolbar.
2. View all detected streams, inspect technical stream details (ITAG, MIME), and click **Download MP4**.

---

## Project Structure

```
google-drive-private/
├── .gitignore         # Ignores .har, .zip, and temporary files
├── manifest.json      # Extension Manifest V3 configuration
├── background.js      # Service Worker (CDP interception & storage persistence)
├── content.js         # Content script (DOM title resolver & Floating Action Button)
├── content.css        # Content script positioning styles
├── popup.html         # Expanded 480px Cyber-Glass popup interface
├── popup.js           # Popup controller with equality check caching
├── icon.png           # Extension icon
└── README.md          # Documentation
```

---

## Author & Developer

Designed and developed with ❤️ by **Vicky**  
- **GitHub Profile**: [@vickyjnv](https://github.com/vickyjnv)  
- **Repository**: [google-drive-private](https://github.com/vickyjnv/google-drive-private)  
- **License**: MIT

