/**
 * Drive Private Video Downloader - Background Service Worker
 * Manifest V3 compatible with chrome.storage.session persistence
 */

const sessionStore = chrome.storage.session || chrome.storage.local;
let activeVideos = {}; // In-memory cache synced with sessionStore
let attachedTabs = new Set();
let extensionEnabled = false;

// Known YouTube/Google Drive ITAG definitions
// Multiplexed formats (Audio + Video in a single MP4/WebM stream):
const MULTIPLEXED_ITAGS = new Set([22, 18, 59, 78, 43, 37, 82, 83, 84, 85]);

// Separate audio-only streams (NO video):
const AUDIO_ONLY_ITAGS = new Set([139, 140, 141, 171, 249, 250, 251]);

// Separate video-only streams (NO audio):
const VIDEO_ONLY_ITAGS = new Set([133, 134, 135, 136, 137, 160, 242, 243, 244, 247, 248, 271, 313, 315]);

const ITAG_HEIGHT_MAP = {
    18: 360,
    22: 720,
    37: 1080,
    43: 360,
    59: 480,
    78: 480,
    133: 240,
    134: 360,
    135: 480,
    136: 720,
    137: 1080,
    160: 144,
    248: 1080,
    271: 1440,
    313: 2160,
    315: 2160
};

// Initialize state from storage
async function initializeState() {
    try {
        const local = await chrome.storage.local.get(['extensionEnabled']);
        extensionEnabled = local.extensionEnabled !== undefined ? local.extensionEnabled : true; // default ON
        await chrome.storage.local.set({ extensionEnabled });

        const session = await sessionStore.get(['capturedVideos']);
        activeVideos = session.capturedVideos || {};
    } catch (e) {
        console.error("Failed to initialize state:", e);
    }
}

initializeState();

// Save captured videos to session storage
async function persistVideos() {
    try {
        await sessionStore.set({ capturedVideos: activeVideos });
    } catch (e) {
        console.error("Failed to persist videos to session storage:", e);
    }
}

// Clean up resources for a tab
function cleanupTab(tabId) {
    if (attachedTabs.has(tabId)) {
        chrome.debugger.detach({ tabId }, () => {
            if (chrome.runtime.lastError) {
                // Ignore detach errors if tab was already closed
            }
        });
        attachedTabs.delete(tabId);
    }
    if (activeVideos[tabId]) {
        delete activeVideos[tabId];
        persistVideos();
    }
}

// Helper to calculate quality height from transcode object
function getQualityHeight(transcode) {
    if (!transcode) return 0;
    const fromLabel = String(transcode.qualityLabel || transcode.quality || '').match(/(\d+)p/i);
    if (fromLabel) return Number(fromLabel[1]);
    return Number(transcode.height || transcode.targetHeight || 0) || 0;
}

// Priority scoring that GUARANTEES multiplexed streams (Audio + Video) are picked first
function scoreTranscode(transcode) {
    if (!transcode) return -1;
    const itag = Number(transcode.itag);
    const mime = String(transcode.mimeType || transcode.mime || '').toLowerCase();
    
    // Hard filter against audio-only tracks
    if (AUDIO_ONLY_ITAGS.has(itag) || mime.includes('audio/')) {
        return -1;
    }

    const height = getQualityHeight(transcode) || ITAG_HEIGHT_MAP[itag] || 0;
    const isMultiplexed = MULTIPLEXED_ITAGS.has(itag);

    // Multiplexed (Audio+Video) streams get a massive +10000 boost
    // so itag 22 (720p + audio) = 10720, itag 18 (360p + audio) = 10360
    // whereas itag 137 (1080p silent) = 1080.
    let baseScore = height;
    if (isMultiplexed) {
        baseScore += 10000;
    } else if (VIDEO_ONLY_ITAGS.has(itag)) {
        baseScore += 0; // Video only, no audio
    }

    return baseScore;
}

// Select the best stream, strongly prioritizing multiplexed audio+video
function getBestVideoTranscode(transcodes) {
    if (!Array.isArray(transcodes) || transcodes.length === 0) return null;

    const validCandidates = transcodes.filter(t => t && t.url && scoreTranscode(t) > 0);
    if (validCandidates.length === 0) return null;

    return validCandidates.reduce((best, current) => {
        const scoreCurrent = scoreTranscode(current);
        const scoreBest = scoreTranscode(best);

        if (scoreCurrent !== scoreBest) {
            return scoreCurrent > scoreBest ? current : best;
        }

        // Secondary: Higher file size / bitrate
        const bytesCurrent = Number(current.contentLength || current.approximateBytes || 0);
        const bytesBest = Number(best.contentLength || best.approximateBytes || 0);
        if (bytesCurrent !== bytesBest) {
            return bytesCurrent > bytesBest ? current : best;
        }

        // Tertiary: Higher FPS
        const fpsCurrent = Number(current.fps || 0);
        const fpsBest = Number(best.fps || 0);
        if (fpsCurrent !== fpsBest) {
            return fpsCurrent > fpsBest ? current : best;
        }

        return current;
    }, validCandidates[0]);
}

// Format bytes to readable size
function formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return 'Unknown size';
    if (size >= 1073741824) return `${(size / 1073741824).toFixed(1)} GB`;
    if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
}

// Parse details from videoplayback URL
function parseVideoUrl(url) {
    try {
        const parsed = new URL(url);
        const params = parsed.searchParams;
        const itag = Number(params.get('itag') || 0);
        const mime = params.get('mime') || '';
        const clen = Number(params.get('clen') || 0);
        const driveId = params.get('driveid') || '';
        const qualityLabel = params.get('quality_label') || '';
        const height = Number(params.get('height') || 0) || ITAG_HEIGHT_MAP[itag] || 0;

        const isAudioOnly = AUDIO_ONLY_ITAGS.has(itag) || mime.includes('audio/');
        const isMultiplexed = MULTIPLEXED_ITAGS.has(itag);

        return {
            url,
            itag,
            driveId,
            mimeType: mime,
            contentLength: clen,
            height,
            qualityLabel: qualityLabel || (height ? `${height}p` : 'Auto'),
            isAudioOnly,
            isMultiplexed
        };
    } catch (e) {
        return null;
    }
}

// Clean and sanitize file names
function sanitizeFilename(name) {
    if (!name) return 'video';
    let clean = String(name)
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

    clean = clean.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                 .replace(/\s+/g, ' ')
                 .trim();
    return clean || 'video';
}

// Attach debugger to a tab
function attachDebugger(tabId) {
    if (attachedTabs.has(tabId)) return;
    const debuggee = { tabId };
    chrome.debugger.attach(debuggee, "1.3", () => {
        if (chrome.runtime.lastError) return;
        attachedTabs.add(tabId);
        chrome.debugger.sendCommand(debuggee, "Network.enable", {}, () => {
            if (chrome.runtime.lastError) {
                attachedTabs.delete(tabId);
            }
        });
    });
}

// Detach debugger from a tab
function detachDebugger(tabId) {
    if (!attachedTabs.has(tabId)) return;
    chrome.debugger.detach({ tabId }, () => {
        if (chrome.runtime.lastError) return;
        attachedTabs.delete(tabId);
    });
}

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url?.startsWith("https://drive.google.com/")) {
        if (extensionEnabled) {
            attachDebugger(tabId);
        }
    }
});

// Clean up when tab is removed
chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupTab(tabId);
});

// Detached debugger notification
chrome.debugger.onDetach.addListener((debuggeeId) => {
    attachedTabs.delete(debuggeeId.tabId);
});

// Handle CDP network events
chrome.debugger.onEvent.addListener((debuggeeId, method, params) => {
    const tabId = debuggeeId.tabId;
    if (!extensionEnabled) return;

    if (method === "Network.requestWillBeSent") {
        const reqUrl = params.request?.url || '';
        const isDriveMedia = reqUrl.includes("videoplayback") || reqUrl.includes("workspacevideo-pa.clients6.google.com");

        if (isDriveMedia) {
            const parsed = parseVideoUrl(reqUrl);
            if (!parsed || parsed.isAudioOnly) return;

            // Only track valid video candidates
            recordCapturedVideo(tabId, {
                requestId: params.requestId,
                driveId: parsed.driveId,
                rawUrl: reqUrl,
                downloadUrl: reqUrl,
                itag: parsed.itag,
                quality: parsed.qualityLabel || (parsed.height ? `${parsed.height}p` : 'Best'),
                height: parsed.height,
                isMultiplexed: parsed.isMultiplexed,
                audioStatus: parsed.isMultiplexed ? "Audio + Video" : "Video Only (Adaptive)",
                fileSizeBytes: parsed.contentLength,
                fileSize: formatBytes(parsed.contentLength),
                mimeType: parsed.mimeType || 'video/mp4',
                timestamp: Date.now()
            });
        }
    } else if (method === "Network.responseReceived") {
        const reqUrl = params.response?.url || '';
        const requestId = params.requestId;
        const isDriveMedia = reqUrl.includes("videoplayback") || reqUrl.includes("workspacevideo-pa.clients6.google.com");

        if (isDriveMedia) {
            chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }, (result) => {
                if (chrome.runtime.lastError || !result?.body) return;

                try {
                    const data = JSON.parse(result.body);
                    const progressive = data.mediaStreamingData?.formatStreamingData?.progressiveTranscodes;
                    if (Array.isArray(progressive) && progressive.length > 0) {
                        const best = getBestVideoTranscode(progressive);
                        if (best && best.url) {
                            const parsed = parseVideoUrl(best.url);
                            const height = getQualityHeight(best) || parsed?.height || 0;
                            const itag = Number(best.itag || parsed?.itag || 0);
                            const isMultiplexed = MULTIPLEXED_ITAGS.has(itag) || (height > 0 && !VIDEO_ONLY_ITAGS.has(itag));
                            const bytes = Number(best.contentLength || parsed?.contentLength || 0);

                            recordCapturedVideo(tabId, {
                                requestId,
                                driveId: parsed?.driveId || '',
                                rawUrl: best.url,
                                downloadUrl: best.url,
                                itag,
                                quality: best.qualityLabel || (height ? `${height}p` : 'Best'),
                                height,
                                isMultiplexed,
                                audioStatus: isMultiplexed ? "Audio + Video" : "Video Only (Adaptive)",
                                fileSizeBytes: bytes,
                                fileSize: formatBytes(bytes),
                                mimeType: best.mimeType || parsed?.mimeType || 'video/mp4',
                                timestamp: Date.now()
                            });
                        }
                    }
                } catch (err) {
                    // Not a JSON response or already parsed URL
                }
            });
        }
    }
});

// Store and broadcast captured video
function recordCapturedVideo(tabId, videoData) {
    if (!activeVideos[tabId]) {
        activeVideos[tabId] = [];
    }

    // Try to get title from the web page via content script
    resolveVideoTitle(tabId, videoData.driveId, (foundTitle) => {
        videoData.videoTitle = foundTitle;

        // Check if stream with same driveId / quality already exists
        const existingIndex = activeVideos[tabId].findIndex(v => 
            (v.driveId && videoData.driveId && v.driveId === videoData.driveId && v.itag === videoData.itag) ||
            v.downloadUrl === videoData.downloadUrl
        );

        if (existingIndex >= 0) {
            activeVideos[tabId][existingIndex] = { ...activeVideos[tabId][existingIndex], ...videoData };
        } else {
            // Put highest score multiplexed video at the top
            activeVideos[tabId].unshift(videoData);
        }

        // Sort tab videos so multiplexed formats come first, then highest resolution
        activeVideos[tabId].sort((a, b) => {
            const scoreA = (a.isMultiplexed ? 10000 : 0) + (a.height || 0);
            const scoreB = (b.isMultiplexed ? 10000 : 0) + (b.height || 0);
            return scoreB - scoreA;
        });

        persistVideos();

        // Broadcast to content script for Floating Action Button
        chrome.tabs.sendMessage(tabId, {
            type: "videoDetected",
            videos: activeVideos[tabId]
        }).catch(() => {
            // Content script not ready yet, safe to ignore
        });
    });
}

// Request real video filename from content script DOM inspection
function resolveVideoTitle(tabId, driveId, callback) {
    chrome.tabs.sendMessage(tabId, { type: "extractDriveTitle", driveId }, (response) => {
        if (!chrome.runtime.lastError && response?.title && response.title.trim() && !isLikelyFolderName(response.title)) {
            callback(sanitizeFilename(response.title));
            return;
        }

        // Fallback: check tab title
        chrome.tabs.get(tabId, (tab) => {
            if (tab?.title) {
                const cleaned = sanitizeFilename(tab.title);
                if (cleaned && !isLikelyFolderName(cleaned)) {
                    callback(cleaned);
                    return;
                }
            }
            callback(`Drive_Video_${driveId ? driveId.substring(0, 8) : Date.now()}`);
        });
    });
}

function isLikelyFolderName(name) {
    const lower = name.toLowerCase().trim();
    return lower === "google drive" || lower === "my drive" || lower === "shared with me" || lower === "drive";
}

// Message handler for Popup and Content Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "setEnabled") {
        extensionEnabled = Boolean(message.enabled);
        chrome.storage.local.set({ extensionEnabled }, () => {
            if (message.enabled) {
                if (message.tabId) attachDebugger(message.tabId);
            } else {
                if (message.tabId) detachDebugger(message.tabId);
                activeVideos = {};
                persistVideos();
            }
            sendResponse({ success: true, enabled: extensionEnabled });
        });
        return true;
    }

    if (message.type === "getVideos") {
        const tabId = message.tabId || sender.tab?.id;
        const videos = activeVideos[tabId] || [];
        sendResponse({ videos, extensionEnabled });
        return true;
    }

    if (message.type === "updateVideoTitle") {
        const tabId = message.tabId || sender.tab?.id;
        if (tabId && activeVideos[tabId]) {
            let updated = false;
            activeVideos[tabId].forEach(v => {
                if (!message.driveId || v.driveId === message.driveId) {
                    v.videoTitle = sanitizeFilename(message.title);
                    updated = true;
                }
            });
            if (updated) {
                persistVideos();
                sendResponse({ success: true });
                return true;
            }
        }
        sendResponse({ success: false });
        return true;
    }

    if (message.type === "downloadVideo") {
        const video = message.video;
        if (!video || !video.downloadUrl) {
            sendResponse({ success: false, error: "Invalid video URL" });
            return true;
        }

        let filename = sanitizeFilename(video.videoTitle || 'drive_video');
        if (!filename.toLowerCase().endsWith('.mp4')) {
            filename += '.mp4';
        }

        chrome.downloads.download({
            url: video.downloadUrl,
            filename: filename,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, downloadId });
            }
        });
        return true;
    }
});