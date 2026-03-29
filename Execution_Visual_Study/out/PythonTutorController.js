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
exports.PythonTutorController = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const TARGET_BLOCKS_JSON = 'blocks_entire.json';
class PythonTutorController {
    extensionUri;
    onStepChanged;
    getActiveCaseRoot;
    panel;
    disposables = [];
    steps = [];
    constructor(extensionUri, onStepChanged, getActiveCaseRoot) {
        this.extensionUri = extensionUri;
        this.onStepChanged = onStepChanged;
        this.getActiveCaseRoot = getActiveCaseRoot;
    }
    async play() {
        const workspaceRoot = this.getWorkspaceRoot();
        const caseRoot = this.getActiveCaseRoot?.() ?? workspaceRoot;
        if (!workspaceRoot || !caseRoot) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        this.ensurePanel(workspaceRoot);
        await this.refreshSource(caseRoot, true);
    }
    async terminate(showMessage = true) {
        this.onStepChanged?.(undefined);
        if (showMessage) {
            vscode.window.showInformationMessage('PythonTutor playback terminated.');
        }
    }
    async close() {
        await this.terminate(false);
        this.panel?.dispose();
        this.panel = undefined;
    }
    dispose() {
        void this.terminate(false);
        this.panel?.dispose();
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
        this.panel = vscode.window.createWebviewPanel('visualPilotPythonTutor', 'PythonTutor Explain', {
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
        this.panel.webview.html = this.getWebviewHtml();
        const disposeDisposable = this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
        const messageDisposable = this.panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'ready') {
                const caseRoot = this.getActiveCaseRoot?.() ?? workspaceRoot;
                if (caseRoot) {
                    await this.refreshSource(caseRoot, false);
                }
                return;
            }
            if (message.command === 'first') {
                this.panel?.webview.postMessage({ command: 'jumpFirst' });
                return;
            }
            if (message.command === 'last') {
                this.panel?.webview.postMessage({ command: 'jumpLast' });
                return;
            }
            if (message.command === 'prev') {
                this.panel?.webview.postMessage({ command: 'jumpPrev' });
                return;
            }
            if (message.command === 'next') {
                this.panel?.webview.postMessage({ command: 'jumpNext' });
                return;
            }
            if (message.command === 'syncBlock') {
                if (typeof message.blockId === 'number') {
                    const step = this.steps.find((item) => item.id === message.blockId);
                    if (step) {
                        this.onStepChanged?.({
                            id: step.id,
                            name: step.name,
                            cstart: step.cstart,
                            cend: step.cend,
                            tstart: step.tstart,
                            tend: step.tend,
                            file: step.file
                        });
                        return;
                    }
                }
                this.onStepChanged?.(undefined);
            }
        });
        this.disposables.push(disposeDisposable, messageDisposable);
    }
    async refreshSource(caseRoot, notifyWhenMissing) {
        if (!this.panel) {
            return;
        }
        const tutorRoot = path.join(caseRoot, '__debug', 'pythontutor');
        const graphRoot = path.join(tutorRoot, 'graph');
        const blocksPath = path.join(tutorRoot, TARGET_BLOCKS_JSON);
        const blocks = this.loadBlocks(blocksPath);
        const images = this.loadImages(graphRoot, this.panel.webview);
        this.steps = this.buildSteps(blocks, images);
        if (this.steps.length === 0) {
            if (notifyWhenMissing) {
                vscode.window.showWarningMessage('No usable pythonTutor graph images or blocks_entire.json found in __debug/pythontutor.');
            }
            this.panel.webview.postMessage({
                command: 'setSteps',
                steps: [],
                label: 'No pythonTutor steps available.'
            });
            this.onStepChanged?.(undefined);
            return;
        }
        this.panel.webview.postMessage({
            command: 'setSteps',
            steps: this.steps,
            label: `${this.steps.length} steps loaded`
        });
    }
    loadBlocks(blocksPath) {
        if (!fs.existsSync(blocksPath)) {
            return [];
        }
        try {
            const raw = JSON.parse(fs.readFileSync(blocksPath, 'utf8'));
            const sharedFile = typeof raw.file === 'string' ? raw.file : undefined;
            if (!Array.isArray(raw.blocks)) {
                return [];
            }
            return raw.blocks
                .filter((item) => typeof item?.id === 'number' && typeof item?.name === 'string')
                .map((item) => ({
                id: item.id,
                name: item.name,
                cstart: typeof item?.cstart === 'number' ? item.cstart : undefined,
                cend: typeof item?.cend === 'number' ? item.cend : undefined,
                tstart: typeof item?.tstart === 'number' ? item.tstart : undefined,
                tend: typeof item?.tend === 'number' ? item.tend : undefined,
                file: sharedFile
            }))
                .sort((a, b) => a.id - b.id);
        }
        catch {
            return [];
        }
    }
    loadImages(graphRoot, webview) {
        if (!fs.existsSync(graphRoot)) {
            return [];
        }
        let entries = [];
        try {
            entries = fs.readdirSync(graphRoot, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const images = entries
            .filter((entry) => entry.isFile() && /\.(png|jpg|jpeg|gif|webp)$/i.test(entry.name))
            .map((entry) => {
            const base = path.parse(entry.name).name;
            const match = base.match(/(\d+)(?!.*\d)/);
            const numericId = match ? Number.parseInt(match[1], 10) : Number.NaN;
            if (!Number.isInteger(numericId)) {
                return undefined;
            }
            const fullPath = path.join(graphRoot, entry.name);
            return {
                id: numericId,
                src: webview.asWebviewUri(vscode.Uri.file(fullPath)).toString()
            };
        })
            .filter((item) => !!item)
            .sort((a, b) => a.id - b.id);
        return images;
    }
    buildSteps(blocks, images) {
        if (blocks.length === 0 || images.length === 0) {
            return [];
        }
        const imageById = new Map();
        for (const image of images) {
            imageById.set(image.id, image.src);
        }
        const steps = [];
        for (let index = 0; index < blocks.length; index += 1) {
            const block = blocks[index];
            const direct = imageById.get(block.id);
            const oneBasedForward = imageById.get(block.id + 1);
            const oneBasedBackward = imageById.get(block.id - 1);
            const fallback = images[index]?.src;
            const imageSrc = direct ?? oneBasedForward ?? oneBasedBackward ?? fallback;
            if (!imageSrc) {
                continue;
            }
            steps.push({
                id: block.id,
                name: block.name,
                imageSrc,
                cstart: block.cstart,
                cend: block.cend,
                tstart: block.tstart,
                tend: block.tend,
                file: block.file
            });
        }
        return steps;
    }
    getWorkspaceRoot() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return folders[0].uri.fsPath;
    }
    getWebviewHtml() {
        const nonce = String(Date.now());
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>PythonTutor Explain</title>
    <style>
        body {
            margin: 0;
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
        }

        .container {
            flex: 1;
            display: flex;
            gap: 8px;
            padding: 8px;
            min-width: 0;
        }

        .left {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .controls {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 6px;
        }

        button {
            border: none;
            border-radius: 6px;
            padding: 6px 8px;
            cursor: pointer;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .image-wrap {
            flex: 1;
            min-height: 180px;
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 8px;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            background: #000;
        }

        img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }

        .empty {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 10px;
            font-size: 13px;
        }

        .status {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .right {
            width: 230px;
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 8px;
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-height: 0;
        }

        .list-title {
            font-size: 12px;
            font-weight: 600;
        }

        .blocks {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 6px;
        }

        .row {
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .row:last-child {
            border-bottom: none;
        }

        .row.active {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
    </style>
</head>
<body>
    <div class="container">
        <section class="left">
            <div class="controls">
                <button id="firstBtn">First</button>
                <button id="prevBtn">Step -</button>
                <button id="nextBtn">Step +</button>
                <button id="lastBtn">Last</button>
            </div>
            <div class="image-wrap">
                <img id="graphImage" alt="pythonTutor graph" />
                <div id="empty" class="empty">Waiting for pythonTutor graph images...</div>
            </div>
            <div id="status" class="status"></div>
        </section>
        <aside class="right">
            <div class="list-title">Blocks</div>
            <div id="blocks" class="blocks"></div>
        </aside>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const graphImage = document.getElementById('graphImage');
        const empty = document.getElementById('empty');
        const status = document.getElementById('status');
        const blocksEl = document.getElementById('blocks');
        let steps = [];
        let activeIndex = -1;

        function render() {
            blocksEl.innerHTML = '';

            if (!steps.length) {
                graphImage.removeAttribute('src');
                graphImage.style.display = 'none';
                empty.style.display = 'flex';
                status.textContent = 'No steps';
                return;
            }

            const safeIndex = Math.max(0, Math.min(steps.length - 1, activeIndex < 0 ? 0 : activeIndex));
            activeIndex = safeIndex;
            const step = steps[safeIndex];

            graphImage.src = step.imageSrc;
            graphImage.style.display = 'block';
            empty.style.display = 'none';
            status.textContent = 'Showing step #' + step.id + ' (' + (safeIndex + 1) + '/' + steps.length + ')';

            steps.forEach((item, index) => {
                const row = document.createElement('div');
                row.className = 'row' + (index === safeIndex ? ' active' : '');
                row.textContent = '#' + item.id + ' ' + item.name;
                row.addEventListener('click', () => {
                    activeIndex = index;
                    render();
                    vscode.postMessage({ command: 'syncBlock', blockId: steps[activeIndex].id });
                });
                blocksEl.appendChild(row);
            });

            vscode.postMessage({ command: 'syncBlock', blockId: step.id });
        }

        function jumpTo(index) {
            if (!steps.length) {
                return;
            }

            activeIndex = Math.max(0, Math.min(steps.length - 1, index));
            render();
        }

        document.getElementById('firstBtn').addEventListener('click', () => {
            jumpTo(0);
        });

        document.getElementById('lastBtn').addEventListener('click', () => {
            jumpTo(steps.length - 1);
        });

        document.getElementById('prevBtn').addEventListener('click', () => {
            jumpTo((activeIndex < 0 ? 0 : activeIndex) - 1);
        });

        document.getElementById('nextBtn').addEventListener('click', () => {
            jumpTo((activeIndex < 0 ? -1 : activeIndex) + 1);
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'setSteps') {
                steps = Array.isArray(message.steps) ? message.steps : [];
                activeIndex = steps.length ? 0 : -1;
                render();
                return;
            }

            if (message.command === 'jumpFirst') {
                jumpTo(0);
                return;
            }

            if (message.command === 'jumpLast') {
                jumpTo(steps.length - 1);
                return;
            }

            if (message.command === 'jumpPrev') {
                jumpTo((activeIndex < 0 ? 0 : activeIndex) - 1);
                return;
            }

            if (message.command === 'jumpNext') {
                jumpTo((activeIndex < 0 ? -1 : activeIndex) + 1);
            }
        });

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
exports.PythonTutorController = PythonTutorController;
//# sourceMappingURL=PythonTutorController.js.map