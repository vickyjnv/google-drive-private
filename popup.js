/**
 * Drive Private Video Downloader - Popup Script
 * Includes equality checking to completely prevent UI re-render flickering
 */

document.addEventListener("DOMContentLoaded", async () => {
    const videoListContainer = document.getElementById("videoListContainer");
    const emptyStateContainer = document.getElementById("emptyStateContainer");
    const nonDriveCard = document.getElementById("nonDriveCard");
    const reloadTabBtn = document.getElementById("reloadTabBtn");
    const toggleOn = document.getElementById("toggleOn");
    const toggleOff = document.getElementById("toggleOff");
    const engineDot = document.getElementById("engineDot");
    const engineStatusText = document.getElementById("engineStatusText");
    const videoCountBadge = document.getElementById("videoCountBadge");

    let currentActiveTab = null;
    let lastRenderedHash = null;

    // Get current active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentActiveTab = tabs[0];

    const isDrivePage = currentActiveTab?.url?.startsWith("https://drive.google.com/");

    if (!isDrivePage) {
        nonDriveCard.classList.remove("hidden");
        emptyStateContainer.classList.add("hidden");
        videoListContainer.classList.add("hidden");
        engineStatusText.textContent = "Standby (Non-Drive Tab)";
        engineDot.classList.add("offline");
        return;
    }

    // Initialize Engine Enabled status
    const localStore = await chrome.storage.local.get(["extensionEnabled"]);
    const isEnabled = localStore.extensionEnabled !== undefined ? localStore.extensionEnabled : true;
    updateEngineUI(isEnabled);

    // Event listener for ON/OFF buttons
    toggleOn.addEventListener("click", () => setEngineEnabled(true));
    toggleOff.addEventListener("click", () => setEngineEnabled(false));

    // Reload active Google Drive tab
    reloadTabBtn.addEventListener("click", () => {
        if (currentActiveTab?.id) {
            chrome.tabs.reload(currentActiveTab.id);
        }
    });

    function updateEngineUI(enabled) {
        if (enabled) {
            toggleOn.classList.add("active", "on");
            toggleOff.classList.remove("active", "off");
            engineDot.classList.remove("offline");
            engineStatusText.textContent = "Capturing Engine Active";
        } else {
            toggleOff.classList.add("active", "off");
            toggleOn.classList.remove("active", "on");
            engineDot.classList.add("offline");
            engineStatusText.textContent = "Capturing Engine Paused";
        }
    }

    function setEngineEnabled(enabled) {
        updateEngineUI(enabled);
        chrome.runtime.sendMessage({
            type: "setEnabled",
            enabled,
            tabId: currentActiveTab?.id
        }, () => {
            if (enabled && currentActiveTab?.id) {
                chrome.tabs.reload(currentActiveTab.id);
            }
            refreshVideos();
        });
    }

    /**
     * Compute a deterministic hash/signature of the video array
     * to prevent wiping/rebuilding DOM when data hasn't changed
     */
    function computeVideoHash(videos) {
        if (!Array.isArray(videos) || videos.length === 0) return "EMPTY";
        return videos.map(v => 
            `${v.id || v.requestId}_${v.videoTitle}_${v.quality}_${v.fileSize}_${v.isMultiplexed}_${v.downloadUrl}`
        ).join("||");
    }

    // Refresh videos from background worker
    function refreshVideos() {
        if (!currentActiveTab?.id) return;

        chrome.runtime.sendMessage({
            type: "getVideos",
            tabId: currentActiveTab.id
        }, (response) => {
            if (chrome.runtime.lastError || !response) return;

            const videos = response.videos || [];
            videoCountBadge.textContent = `${videos.length} stream${videos.length === 1 ? '' : 's'} detected`;

            // EQUALITY CHECK:
            // If the video data signature is identical, do not rebuild or touch the DOM!
            const newHash = computeVideoHash(videos);
            if (newHash === lastRenderedHash) {
                return; // Nothing changed, skip DOM thrashing!
            }
            lastRenderedHash = newHash;

            renderVideoList(videos);
        });
    }

    // Render list into DOM
    function renderVideoList(videos) {
        if (!videos || videos.length === 0) {
            videoListContainer.innerHTML = "";
            emptyStateContainer.classList.remove("hidden");
            return;
        }

        emptyStateContainer.classList.add("hidden");
        videoListContainer.innerHTML = "";

        videos.forEach((video) => {
            const card = document.createElement("div");
            card.classList.add("video-card");

            const isMultiplexed = video.isMultiplexed;
            const title = video.videoTitle || "Google Drive Video";
            const quality = video.quality || "Best";
            const size = video.fileSize || "Direct Stream";

            card.innerHTML = `
                <div class="card-top">
                    <div class="video-media-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                    </div>
                    <div class="card-info">
                        <div class="card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
                        <div class="card-badges">
                            <span class="badge badge-quality">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                ${quality}
                            </span>
                            <span class="badge badge-audio ${isMultiplexed ? '' : 'warning'}">
                                ${isMultiplexed ? '🔊 Audio + Video' : '⚠ Video Only'}
                            </span>
                            <span class="badge badge-size">${size}</span>
                        </div>
                    </div>
                </div>

                <div class="stream-details" id="details-${escapeHtml(video.requestId || 'req')}">
                    <div class="detail-row">
                        <span class="detail-label">Format / Codec</span>
                        <span class="detail-value">${escapeHtml(video.mimeType || 'video/mp4')}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">ITAG Code</span>
                        <span class="detail-value">${video.itag || 'N/A'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Drive Item ID</span>
                        <span class="detail-value">${escapeHtml(video.driveId || 'N/A')}</span>
                    </div>
                </div>

                <div class="card-actions">
                    <button class="download-action-btn" id="dlBtn-${escapeHtml(video.requestId || 'req')}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Download MP4 (${quality})
                    </button>
                    <button class="details-toggle-btn" id="toggleDetailsBtn-${escapeHtml(video.requestId || 'req')}">
                        Details
                    </button>
                </div>
            `;

            // Wire Download Action
            const dlBtn = card.querySelector(`#dlBtn-${CSS.escape(video.requestId || 'req')}`);
            if (dlBtn) {
                dlBtn.addEventListener("click", () => {
                    dlBtn.textContent = "Starting Download...";
                    dlBtn.style.opacity = "0.8";

                    chrome.runtime.sendMessage({
                        type: "downloadVideo",
                        video: video
                    }, (res) => {
                        setTimeout(() => {
                            dlBtn.innerHTML = `✓ Download Started`;
                            dlBtn.style.background = "#059669";
                            dlBtn.style.opacity = "1";
                        }, 500);
                    });
                });
            }

            // Wire Stream Details Toggle
            const toggleDetailsBtn = card.querySelector(`#toggleDetailsBtn-${CSS.escape(video.requestId || 'req')}`);
            const detailsPanel = card.querySelector(`#details-${CSS.escape(video.requestId || 'req')}`);
            if (toggleDetailsBtn && detailsPanel) {
                toggleDetailsBtn.addEventListener("click", () => {
                    const isOpen = detailsPanel.classList.toggle("open");
                    toggleDetailsBtn.textContent = isOpen ? "Hide" : "Details";
                });
            }

            videoListContainer.appendChild(card);
        });
    }

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Initial load
    refreshVideos();

    // Listen for storage changes in real-time
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "session" || area === "local") {
            refreshVideos();
        }
    });

    // GitHub Profile button
    const githubBtn = document.getElementById("githubBtn");
    if (githubBtn) {
        githubBtn.addEventListener("click", () => {
            chrome.tabs.create({ url: "https://github.com/vickyjnv" });
        });
    }

    // Gentle polling fallback (every 1.5s)
    setInterval(refreshVideos, 1500);
});