/**
 * Drive Private Video Downloader - Content Script
 * 1. Accurately extracts video file names from Drive DOM (preventing folder names)
 * 2. Injects a sleek in-page Floating Action Button with rich tooltip & direct download
 */

(() => {
    let hostElement = null;
    let shadowRoot = null;
    let currentVideos = [];
    let isWidgetVisible = true;

    // Common video extensions
    const VIDEO_EXTENSIONS = /\.(mp4|mkv|mov|avi|webm|flv|m4v|3gp|wmv|ts)$/i;

    /**
     * Intelligent DOM title extractor
     * Fixes the issue where folder names were selected instead of video names
     */
    function extractVideoFileName(driveId) {
        // Strategy 1: Check by Drive item ID
        if (driveId) {
            const idSelectors = [
                `[data-id="${driveId}"]`,
                `[data-item-id="${driveId}"]`,
                `[data-target-id="${driveId}"]`
            ];
            for (const sel of idSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const titleAttr = el.getAttribute('data-target="title"') ||
                                      el.getAttribute('title') ||
                                      el.getAttribute('aria-label');
                    if (titleAttr && isValidVideoName(titleAttr)) {
                        return cleanFileName(titleAttr);
                    }
                    const textEl = el.querySelector('[data-target="title"]') || el;
                    if (textEl && textEl.innerText && isValidVideoName(textEl.innerText)) {
                        return cleanFileName(textEl.innerText);
                    }
                }
            }
        }

        // Strategy 2: Active Preview Modal / Dialog
        const previewDialog = document.querySelector('div[role="dialog"]');
        if (previewDialog) {
            // Check preview toolstrip title
            const toolstrip = previewDialog.querySelector('.drive-viewer-toolstrip-name') ||
                              document.querySelector('.drive-viewer-toolstrip-name');
            if (toolstrip && toolstrip.innerText && isValidVideoName(toolstrip.innerText)) {
                return cleanFileName(toolstrip.innerText);
            }

            // Check data-target="title" inside dialog
            const titleTarget = previewDialog.querySelector('[data-target="title"]');
            if (titleTarget && titleTarget.innerText && isValidVideoName(titleTarget.innerText)) {
                return cleanFileName(titleTarget.innerText);
            }

            // Check elements with explicit video extension in aria-label or title
            const elementsWithExt = previewDialog.querySelectorAll('[aria-label], [title]');
            for (const el of elementsWithExt) {
                const val = el.getAttribute('aria-label') || el.getAttribute('title');
                if (val && VIDEO_EXTENSIONS.test(val)) {
                    return cleanFileName(val);
                }
            }

            // Heading inside dialog
            const heading = previewDialog.querySelector('div[role="heading"], h1, h2, h3');
            if (heading && heading.innerText && isValidVideoName(heading.innerText)) {
                return cleanFileName(heading.innerText);
            }
        }

        // Strategy 3: Currently selected item in Drive list/grid
        const selectedItem = document.querySelector('[aria-selected="true"]');
        if (selectedItem) {
            const label = selectedItem.getAttribute('aria-label') ||
                          selectedItem.getAttribute('title') ||
                          selectedItem.innerText;
            if (label && isValidVideoName(label)) {
                return cleanFileName(label);
            }
        }

        // Strategy 4: Document title if on /file/d/.../view
        if (window.location.pathname.includes('/file/d/')) {
            const docTitle = document.title;
            if (docTitle && isValidVideoName(docTitle)) {
                return cleanFileName(docTitle);
            }
        }

        // Strategy 5: Query any video element and check closest container
        const videoElement = document.querySelector('video');
        if (videoElement) {
            const container = videoElement.closest('[role="dialog"]') || videoElement.closest('.drive-viewer');
            if (container) {
                const headerText = container.querySelector('[title], [aria-label]')?.getAttribute('title');
                if (headerText && isValidVideoName(headerText)) {
                    return cleanFileName(headerText);
                }
            }
        }

        return null;
    }

    function isValidVideoName(str) {
        if (!str) return false;
        const s = str.trim().toLowerCase();
        if (s === "google drive" || s === "my drive" || s === "shared with me" || s === "trash" || s === "recent" || s === "folders") {
            return false;
        }
        if (s.startsWith("drive -") || s.includes("google drive folder")) {
            return false;
        }
        return true;
    }

    function cleanFileName(str) {
        if (!str) return 'video';
        let clean = String(str)
            .replace(/\s*-\s*Google Drive$/i, '')
            .replace(/^(Preview of|Viewing)\s+/i, '')
            .replace(/\bvideoplayback\b/gi, '')
            .trim();

        // If filename has a video extension, strip trailing Google Drive sharing suffixes (e.g. " - Shared - Vicky ...")
        const extMatch = clean.match(/^(.*?\.(mp4|mkv|mov|avi|webm|flv|m4v|3gp|wmv|ts))(?:\s*[-_–—]\s*.*)?$/i);
        if (extMatch) {
            clean = extMatch[1];
        } else {
            clean = clean.replace(/\s*[-_–—]\s*(?:Shared|Shared with me|Owner|Google Drive).*$/i, '');
        }

        return clean.trim() || 'video';
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Initialize or get Shadow DOM Root for the Floating Action Button
    function ensureShadowRoot() {
        if (shadowRoot) return shadowRoot;

        hostElement = document.getElementById('gdrive-private-video-dl-host');
        if (!hostElement) {
            hostElement = document.createElement('div');
            hostElement.id = 'gdrive-private-video-dl-host';
            document.body.appendChild(hostElement);
        }

        try {
            shadowRoot = hostElement.attachShadow({ mode: 'open' });
        } catch (e) {
            shadowRoot = hostElement.shadowRoot;
        }

        return shadowRoot;
    }

    // Render Floating Action Button and Tooltip Popover
    function renderFloatingButton(videos) {
        if (!Array.isArray(videos) || videos.length === 0 || !isWidgetVisible) {
            if (hostElement) hostElement.style.display = 'none';
            return;
        }

        currentVideos = videos;
        const bestVideo = videos[0]; // Already sorted: best multiplexed stream is first

        const root = ensureShadowRoot();
        hostElement.style.display = 'block';

        const videoTitle = bestVideo.videoTitle || 'Drive Video';
        const displayTitle = videoTitle; // Full filename without any truncation
        const isMultiplexed = bestVideo.isMultiplexed;
        const quality = bestVideo.quality || 'Best';
        const size = bestVideo.fileSize || 'Direct Stream';

        root.innerHTML = `
            <style>
                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                .fab-wrapper {
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                }
                .fab-button {
                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                    color: #ffffff;
                    border: none;
                    border-radius: 14px;
                    padding: 10px 16px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    cursor: pointer;
                    box-shadow: 0 10px 25px -5px rgba(16, 185, 129, 0.45), 0 8px 10px -6px rgba(0, 0, 0, 0.2);
                    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                    outline: none;
                    user-select: none;
                    max-width: 650px;
                }
                .fab-button:hover {
                    transform: translateY(-2px) scale(1.01);
                    box-shadow: 0 16px 30px -5px rgba(16, 185, 129, 0.55), 0 10px 12px -6px rgba(0, 0, 0, 0.3);
                    background: linear-gradient(135deg, #34d399 0%, #059669 100%);
                }
                .fab-button:active {
                    transform: translateY(0) scale(0.98);
                }
                .fab-icon {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 20px;
                    height: 20px;
                    flex-shrink: 0;
                }
                .fab-title-text {
                    font-size: 13px;
                    font-weight: 700;
                    color: #ffffff;
                    max-width: 500px;
                    word-break: break-word;
                    overflow-wrap: anywhere;
                    white-space: normal;
                    line-height: 1.35;
                    text-align: left;
                }
                .fab-badge {
                    background: rgba(255, 255, 255, 0.22);
                    padding: 3px 8px;
                    border-radius: 9999px;
                    font-size: 11px;
                    font-weight: 800;
                    text-transform: uppercase;
                    flex-shrink: 0;
                }
                
                /* Rich Tooltip Popover */
                .fab-popover {
                    position: absolute;
                    bottom: calc(100% + 12px);
                    right: 0;
                    width: 380px;
                    max-width: 90vw;
                    background: rgba(15, 23, 42, 0.96);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    border-radius: 16px;
                    padding: 18px;
                    color: #f1f5f9;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5), 0 0 20px rgba(16, 185, 129, 0.15);
                    opacity: 0;
                    visibility: hidden;
                    transform: translateY(12px) scale(0.97);
                    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                    pointer-events: none;
                    z-index: 100;
                }
                .fab-wrapper:hover .fab-popover,
                .fab-popover:hover {
                    opacity: 1;
                    visibility: visible;
                    transform: translateY(0) scale(1);
                    pointer-events: auto;
                }
                .popover-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 12px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    padding-bottom: 8px;
                }
                .popover-title-row {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .status-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 11px;
                    font-weight: 700;
                    color: #34d399;
                    background: rgba(52, 211, 153, 0.12);
                    padding: 2px 8px;
                    border-radius: 9999px;
                    border: 1px solid rgba(52, 211, 153, 0.25);
                }
                .status-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: #34d399;
                    box-shadow: 0 0 8px #34d399;
                }
                .close-btn {
                    background: none;
                    border: none;
                    color: #94a3b8;
                    cursor: pointer;
                    font-size: 16px;
                    line-height: 1;
                    padding: 2px 6px;
                    border-radius: 6px;
                    transition: color 0.15s;
                }
                .close-btn:hover {
                    color: #ffffff;
                    background: rgba(255, 255, 255, 0.08);
                }
                .video-name {
                    font-size: 14px;
                    font-weight: 600;
                    color: #ffffff;
                    margin-bottom: 12px;
                    line-height: 1.4;
                    word-break: break-word;
                }
                .specs-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 8px;
                    margin-bottom: 16px;
                }
                .spec-card {
                    background: rgba(255, 255, 255, 0.04);
                    border: 1px solid rgba(255, 255, 255, 0.06);
                    border-radius: 10px;
                    padding: 8px 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                .spec-label {
                    font-size: 10px;
                    text-transform: uppercase;
                    color: #94a3b8;
                    font-weight: 600;
                    letter-spacing: 0.5px;
                }
                .spec-val {
                    font-size: 12px;
                    font-weight: 700;
                    color: #e2e8f0;
                }
                .audio-verified {
                    color: #34d399;
                }
                .audio-warning {
                    color: #f59e0b;
                }
                .dl-button {
                    width: 100%;
                    background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
                    color: #ffffff;
                    border: none;
                    border-radius: 10px;
                    padding: 10px;
                    font-size: 13px;
                    font-weight: 700;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    box-shadow: 0 8px 16px rgba(37, 99, 235, 0.35);
                    transition: all 0.2s ease;
                }
                .dl-button:hover {
                    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                    transform: translateY(-1px);
                    box-shadow: 0 10px 20px rgba(37, 99, 235, 0.45);
                }
                .dl-button:active {
                    transform: translateY(0);
                }
                .dl-button.downloading {
                    background: #475569;
                    cursor: wait;
                }
            </style>

            <div class="fab-wrapper">
                <div class="fab-popover">
                    <div class="popover-header">
                        <div class="popover-title-row">
                            <span class="status-chip"><span class="status-dot"></span> Ready to Download</span>
                        </div>
                        <button class="close-btn" id="fabDismissBtn" title="Dismiss">✕</button>
                    </div>

                    <div class="video-name" title="${videoTitle}">${displayTitle}</div>

                    <div class="specs-grid">
                        <div class="spec-card">
                            <span class="spec-label">Quality</span>
                            <span class="spec-val">${quality} MP4</span>
                        </div>
                        <div class="spec-card">
                            <span class="spec-label">File Size</span>
                            <span class="spec-val">${size}</span>
                        </div>
                        <div class="spec-card" style="grid-column: span 2;">
                            <span class="spec-label">Audio & Video Track</span>
                            <span class="spec-val ${isMultiplexed ? 'audio-verified' : 'audio-warning'}">
                                ${isMultiplexed ? '✓ Audio + Video (Multiplexed)' : '⚠ Video Only Track'}
                            </span>
                        </div>
                    </div>

                    <button class="dl-button" id="fabDownloadBtn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Download Video (${quality})
                    </button>
                </div>

                <button class="fab-button" id="fabMainBtn" title="Download: ${escapeHtml(videoTitle)}">
                    <span class="fab-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                    </span>
                    <span class="fab-title-text">${escapeHtml(videoTitle)}</span>
                    <span class="fab-badge">${quality}</span>
                </button>
            </div>
        `;

        // Wire click triggers
        const mainBtn = root.getElementById('fabMainBtn');
        const dlBtn = root.getElementById('fabDownloadBtn');
        const dismissBtn = root.getElementById('fabDismissBtn');

        const triggerDownload = () => {
            if (dlBtn) {
                dlBtn.classList.add('downloading');
                dlBtn.textContent = 'Starting Download...';
            }
            if (mainBtn) {
                const label = mainBtn.querySelector('.fab-title-text');
                if (label) {
                    label.textContent = 'Starting Download...';
                }
            }

            chrome.runtime.sendMessage({
                type: "downloadVideo",
                video: bestVideo
            }, (response) => {
                setTimeout(() => {
                    if (dlBtn) {
                        dlBtn.classList.remove('downloading');
                        dlBtn.innerHTML = `✓ Download Started`;
                    }
                    if (mainBtn) {
                        const label = mainBtn.querySelector('.fab-title-text');
                        if (label) {
                            label.textContent = `✓ Started: ${videoTitle}`;
                        }
                    }
                }, 800);
            });
        };

        if (mainBtn) mainBtn.addEventListener('click', triggerDownload);
        if (dlBtn) dlBtn.addEventListener('click', triggerDownload);
        if (dismissBtn) {
            dismissBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (hostElement) hostElement.style.display = 'none';
                isWidgetVisible = false;
            });
        }
    }

    // Listen for background requests & notifications
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "extractDriveTitle") {
            const detectedTitle = extractVideoFileName(message.driveId);
            sendResponse({ title: detectedTitle });
            return true;
        }

        if (message.type === "videoDetected") {
            if (Array.isArray(message.videos) && message.videos.length > 0) {
                renderFloatingButton(message.videos);
            }
            sendResponse({ received: true });
            return true;
        }
    });

    // Observer to detect preview modal opens and refine video title
    const observer = new MutationObserver(() => {
        if (currentVideos.length > 0) {
            const best = currentVideos[0];
            const liveTitle = extractVideoFileName(best.driveId);
            if (liveTitle && liveTitle !== best.videoTitle && isValidVideoName(liveTitle)) {
                best.videoTitle = liveTitle;
                chrome.runtime.sendMessage({
                    type: "updateVideoTitle",
                    driveId: best.driveId,
                    title: liveTitle
                });
                renderFloatingButton(currentVideos);
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial check on load
    chrome.runtime.sendMessage({ type: "getVideos" }, (response) => {
        if (response && Array.isArray(response.videos) && response.videos.length > 0) {
            renderFloatingButton(response.videos);
        }
    });
})();
