"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlidesOverlayController = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const TARGET_SCENE_VIDEO = 'VisualPilotScene.mp4';
const TARGET_BLOCKS_JSON = 'blocks_entire.json';
class SlidesOverlayController {
    context;
    extensionUri;
    onPlaybackBlockChanged;
    onShowAllPlaybackBlocks;
    getActiveCaseRoot;
    panel;
    outputChannel;
    disposables = [];
    linkageBlocks = [];
    constructor(context, extensionUri, onPlaybackBlockChanged, onShowAllPlaybackBlocks, getActiveCaseRoot) {
        this.context = context;
        this.extensionUri = extensionUri;
        this.onPlaybackBlockChanged = onPlaybackBlockChanged;
        this.onShowAllPlaybackBlocks = onShowAllPlaybackBlocks;
        this.getActiveCaseRoot = getActiveCaseRoot;
        this.outputChannel = vscode.window.createOutputChannel('Execution_Visual_Study Slides');
    }
    async play() {
        const workspaceRoot = this.getWorkspaceRoot();
        const caseRoot = this.getActiveCaseRoot?.() ?? workspaceRoot;
        if (!workspaceRoot || !caseRoot) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        this.ensurePanel(workspaceRoot);
        await this.refreshVideoSource(caseRoot, true);
        this.postControl('play');
    }
    async terminate(showMessage = true, syncAllBlocks = true) {
        this.postControl('terminate');
        if (syncAllBlocks) {
            this.onShowAllPlaybackBlocks?.(this.linkageBlocks);
        }
        if (showMessage) {
            vscode.window.showInformationMessage('Slides playback terminated.');
        }
    }
    async close() {
        await this.terminate(false, false);
        this.panel?.dispose();
        this.panel = undefined;
    }
    dispose() {
        void this.terminate(false);
        this.panel?.dispose();
        this.outputChannel.dispose();
        while (this.disposables.length > 0) {
            const d = this.disposables.pop();
            d?.dispose();
        }
    }
    ensurePanel(workspaceRoot) {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        this.panel = vscode.window.createWebviewPanel('visualPilotSlidesOverlay', 'Execution_Visual_Study Slides', {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true
        }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                this.extensionUri,
                vscode.Uri.file(workspaceRoot)
            ]
        });
        this.panel.webview.html = this.getWebviewHtml(this.panel.webview);
        const disposeDisposable = this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
        const messageDisposable = this.panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'ready') {
                const caseRoot = this.getActiveCaseRoot?.() ?? workspaceRoot;
                if (caseRoot) {
                    await this.refreshVideoSource(caseRoot, false);
                }
                return;
            }
            if (message.command === 'play') {
                await this.play();
                return;
            }
            if (message.command === 'terminate') {
                await this.terminate();
                return;
            }
            if (message.command === 'syncBlock') {
                if (typeof message.blockId === 'number') {
                    const block = this.linkageBlocks.find((item) => item.id === message.blockId);
                    this.onPlaybackBlockChanged?.(block);
                }
                else {
                    this.onPlaybackBlockChanged?.(undefined);
                }
                return;
            }
            if (message.command === 'syncAllBlocks') {
                this.onShowAllPlaybackBlocks?.(this.linkageBlocks);
            }
        });
        this.disposables.push(disposeDisposable, messageDisposable);
    }
    async refreshVideoSource(workspaceRoot, notifyWhenMissing) {
        if (!this.panel) {
            return;
        }
        const videoPath = this.findTargetVideo(workspaceRoot);
        const blocks = this.loadBlocks(workspaceRoot);
        this.linkageBlocks = blocks;
        if (!videoPath) {
            if (notifyWhenMissing) {
                vscode.window.showWarningMessage(`No ${TARGET_SCENE_VIDEO} found in __debug/visualpilot.`);
            }
            this.panel.webview.postMessage({
                command: 'setVideo',
                src: '',
                label: `No ${TARGET_SCENE_VIDEO} generated yet.`,
                blocks
            });
            return;
        }
        const videoStat = fs.statSync(videoPath);
        const videoUri = this.panel.webview.asWebviewUri(vscode.Uri.file(videoPath));
        const refreshUri = `${videoUri.toString()}?t=${videoStat.mtimeMs}`;
        this.outputChannel.appendLine(`Playing mp4: ${videoPath}`);
        this.panel.webview.postMessage({
            command: 'setVideo',
            src: refreshUri,
            label: path.basename(videoPath),
            blocks
        });
    }
    loadBlocks(workspaceRoot) {
        const visualPilotRoot = path.join(workspaceRoot, '__debug', 'visualpilot');
        const blocksPath = path.join(visualPilotRoot, TARGET_BLOCKS_JSON);
        if (!fs.existsSync(blocksPath)) {
            return [];
        }
        try {
            const content = fs.readFileSync(blocksPath, 'utf8');
            const parsed = JSON.parse(content);
            const filePath = typeof parsed?.file === 'string' ? parsed.file : undefined;
            if (!Array.isArray(parsed?.blocks)) {
                return [];
            }
            const rawBlocks = parsed.blocks;
            return rawBlocks
                .filter((item) => typeof item?.id === 'number' &&
                typeof item?.name === 'string' &&
                typeof item?.start === 'number' &&
                typeof item?.end === 'number')
                .map((item) => ({
                id: item.id,
                name: item.name,
                start: item.start,
                end: item.end,
                tstart: typeof item?.tstart === 'number' ? item.tstart : undefined,
                tend: typeof item?.tend === 'number' ? item.tend : undefined,
                cstart: typeof item?.cstart === 'number' ? item.cstart : undefined,
                cend: typeof item?.cend === 'number' ? item.cend : undefined,
                file: filePath
            }))
                .sort((a, b) => a.id - b.id);
        }
        catch {
            return [];
        }
    }
    findTargetVideo(workspaceRoot) {
        const visualPilotRoot = path.join(workspaceRoot, '__debug', 'visualpilot');
        const videoPath = path.join(visualPilotRoot, TARGET_SCENE_VIDEO);
        return fs.existsSync(videoPath) ? videoPath : undefined;
    }
    postControl(command) {
        if (!this.panel) {
            return;
        }
        this.panel.webview.postMessage({
            command: 'control',
            action: command
        });
    }
    getWorkspaceRoot() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return folders[0].uri.fsPath;
    }
    getWebviewHtml(webview) {
        const nonce = String(Date.now());
        const csp = `default-src 'none'; media-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Slides Overlay</title>
    <style>
        :root {
            color-scheme: light dark;
        }

        body {
            margin: 0;
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex;
            height: 100vh;
        }

        button {
            border: none;
            padding: 6px 10px;
            cursor: pointer;
            border-radius: 6px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .status {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-left: auto;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .video-wrap {
            flex: 1;
            padding: 8px;
            display: flex;
            align-items: stretch;
            gap: 8px;
        }

        .video-main {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 0;
            position: relative;
        }

        .video-side {
            width: 220px;
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 8px;
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-editorWidget-border) 10%);
        }

        .side-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        .side-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-editor-foreground);
        }

        .side-status {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            max-width: 120px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            text-align: right;
        }

        .side-main-controls {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 6px;
        }

        .side-main-controls button {
            padding: 5px 6px;
            font-size: 12px;
        }

        .side-controls {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 6px;
        }

        .side-controls button {
            padding: 5px 8px;
            font-size: 12px;
        }

        .blocks-list {
            flex: 1;
            min-height: 120px;
            overflow-y: auto;
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 6px;
        }

        .block-item {
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .block-item:last-child {
            border-bottom: none;
        }

        .block-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .block-item.active {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .block-empty {
            padding: 10px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        video {
            width: 100%;
            height: 100%;
            border: none;
            background: #000;
            border-radius: 8px;
        }

        /* Hide native media controls to avoid subtitle occlusion. */
        video::-webkit-media-controls {
            display: none !important;
        }

        video::-webkit-media-controls-enclosure {
            display: none !important;
        }

        .empty {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            max-width: 520px;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="video-wrap">
        <div class="video-main">
            <video id="slidesVideo"></video>
            <div id="empty" class="empty">Waiting for generated VisualPilotScene.mp4...</div>
        </div>
        <aside class="video-side">
            <div class="side-header">
                <div class="side-title">Anime Explanation</div>
                <div id="status" class="side-status">No mp4</div>
            </div>
            <div class="side-main-controls">
                <button id="playBtn">Play</button>
                <button id="pauseBtn">Pause</button>
                <button id="stopBtn">Stop</button>
            </div>
            <div class="side-controls">
                <button id="prevBlockBtn">Step -</button>
                <button id="nextBlockBtn">Step +</button>
                <button id="replayBlockBtn">Replay</button>
            </div>
            <div id="blocksList" class="blocks-list"></div>
        </aside>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const slidesVideo = document.getElementById('slidesVideo');
        const empty = document.getElementById('empty');
        const status = document.getElementById('status');
        const pauseBtn = document.getElementById('pauseBtn');
        const blocksList = document.getElementById('blocksList');
        let blocks = [];
        let activeBlockIndex = -1;
        let activeBlockEnd = null;
        let syncedBlockId = null;
        let suppressTimeSync = false;
        let lockShowAllMode = false;

        function updateVisibility() {
            const hasSource = Boolean(slidesVideo.src);
            slidesVideo.style.display = hasSource ? 'block' : 'none';
            empty.style.display = hasSource ? 'none' : 'block';
        }

        function updatePauseButton() {
            pauseBtn.textContent = slidesVideo.paused ? 'Resume' : 'Pause';
        }

        function formatSeconds(value) {
            return Number(value).toFixed(2);
        }

        function renderBlocks() {
            blocksList.innerHTML = '';

            if (!blocks.length) {
                const emptyItem = document.createElement('div');
                emptyItem.className = 'block-empty';
                emptyItem.textContent = 'No blocks.json segments';
                blocksList.appendChild(emptyItem);
                return;
            }

            blocks.forEach((block, index) => {
                const row = document.createElement('div');
                row.className = 'block-item';
                if (index === activeBlockIndex || block.id === syncedBlockId) {
                    row.classList.add('active');
                }

                row.textContent = '#' + block.id + ' ' + block.name;

                row.addEventListener('click', () => {
                    playBlock(index);
                });

                blocksList.appendChild(row);
            });
        }

        function playBlock(index) {
            if (!slidesVideo.src || index < 0 || index >= blocks.length) {
                return;
            }

            lockShowAllMode = false;
            const block = blocks[index];
            activeBlockIndex = index;
            activeBlockEnd = block.end;
            slidesVideo.currentTime = block.start;
            renderBlocks();
            status.textContent = 'Playing block';
            syncBlock(block.id);
            void slidesVideo.play().catch(() => {
                status.textContent = 'Click video to start playback';
            });
        }

        function playFull() {
            if (!slidesVideo.src) {
                return;
            }
            lockShowAllMode = false;
            activeBlockIndex = -1;
            activeBlockEnd = null;
            renderBlocks();
            slidesVideo.currentTime = 0;
            status.textContent = 'Playing full video';
            syncBlock(null);
            void slidesVideo.play().catch(() => {
                status.textContent = 'Click video to start playback';
            });
        }

        function syncBlock(blockId) {
            if (syncedBlockId === blockId) {
                return;
            }

            syncedBlockId = blockId;
            vscode.postMessage({
                command: 'syncBlock',
                blockId
            });
        }

        function syncBlockByCurrentTime() {
            if (lockShowAllMode) {
                return;
            }

            if (!slidesVideo.src || !blocks.length) {
                syncBlock(null);
                renderBlocks();
                return;
            }

            const currentTime = slidesVideo.currentTime;
            const hitIndex = blocks.findIndex((block) =>
                currentTime >= Number(block.start) && currentTime < Number(block.end)
            );

            if (hitIndex >= 0) {
                activeBlockIndex = hitIndex;
                syncBlock(blocks[hitIndex].id);
            } else {
                activeBlockIndex = -1;
                syncBlock(null);
            }
            renderBlocks();
        }

        function syncAllBlocks() {
            lockShowAllMode = true;
            syncedBlockId = null;
            vscode.postMessage({ command: 'syncAllBlocks' });
            renderBlocks();
        }

        function stepBlock(offset) {
            if (!blocks.length) {
                return;
            }

            let nextIndex = activeBlockIndex + offset;
            if (activeBlockIndex < 0) {
                nextIndex = offset > 0 ? 0 : blocks.length - 1;
            }

            nextIndex = Math.max(0, Math.min(blocks.length - 1, nextIndex));
            playBlock(nextIndex);
        }

        document.getElementById('playBtn').addEventListener('click', () => {
            playFull();
        });

        document.getElementById('pauseBtn').addEventListener('click', () => {
            if (!slidesVideo.src) {
                return;
            }

            if (slidesVideo.paused) {
                void slidesVideo.play();
            } else {
                slidesVideo.pause();
            }
            updatePauseButton();
        });

        document.getElementById('stopBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'terminate' });
        });

        document.getElementById('prevBlockBtn').addEventListener('click', () => {
            stepBlock(-1);
        });

        document.getElementById('nextBlockBtn').addEventListener('click', () => {
            stepBlock(1);
        });

        document.getElementById('replayBlockBtn').addEventListener('click', () => {
            if (activeBlockIndex >= 0) {
                playBlock(activeBlockIndex);
            }
        });

        window.addEventListener('message', (event) => {
            const message = event.data;

            if (message.command === 'setVideo') {
                blocks = Array.isArray(message.blocks) ? message.blocks : [];
                activeBlockIndex = -1;
                activeBlockEnd = null;
                syncedBlockId = null;
                suppressTimeSync = false;
                lockShowAllMode = false;
                if (message.src) {
                    slidesVideo.src = message.src;
                    status.textContent = message.label || 'Loaded';
                    empty.textContent = 'Loading video...';
                } else {
                    slidesVideo.pause();
                    slidesVideo.removeAttribute('src');
                    slidesVideo.load();
                    status.textContent = message.label || 'No video';
                    empty.textContent = 'Waiting for generated VisualPilotScene.mp4...';
                }
                renderBlocks();
                updatePauseButton();
                updateVisibility();
                syncBlock(null);
                return;
            }

            if (message.command === 'control') {
                switch (message.action) {
                    case 'play':
                        lockShowAllMode = false;
                        playFull();
                        break;
                    case 'terminate':
                        suppressTimeSync = true;
                        lockShowAllMode = true;
                        slidesVideo.pause();
                        slidesVideo.currentTime = 0;
                        activeBlockEnd = null;
                        status.textContent = 'Playback terminated';
                        empty.textContent = 'Playback terminated.';
                        syncAllBlocks();
                        updatePauseButton();
                        updateVisibility();
                        setTimeout(() => {
                            suppressTimeSync = false;
                        }, 0);
                        break;
                }
            }
        });

        updateVisibility();
        updatePauseButton();

        slidesVideo.addEventListener('loadeddata', () => {
            status.textContent = 'VisualPilotScene.mp4 loaded';
        });

        slidesVideo.addEventListener('play', () => {
            updatePauseButton();
        });

        slidesVideo.addEventListener('pause', () => {
            updatePauseButton();
        });

        slidesVideo.addEventListener('timeupdate', () => {
            if (suppressTimeSync) {
                return;
            }

            syncBlockByCurrentTime();

            if (activeBlockEnd === null) {
                return;
            }

            if (slidesVideo.currentTime >= activeBlockEnd - 0.03) {
                slidesVideo.pause();
                slidesVideo.currentTime = activeBlockEnd;
                activeBlockEnd = null;
                updatePauseButton();
            }
        });

        slidesVideo.addEventListener('ended', () => {
            syncAllBlocks();
        });

        slidesVideo.addEventListener('error', () => {
            status.textContent = 'Failed to load mp4';
            empty.textContent = 'VisualPilotScene.mp4 exists but could not be loaded by webview.';
            slidesVideo.removeAttribute('src');
            updateVisibility();
        });

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
exports.SlidesOverlayController = SlidesOverlayController;
//# sourceMappingURL=SlidesOverlayController.js.map