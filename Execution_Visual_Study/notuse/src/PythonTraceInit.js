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
exports.initPythonTrace = initPythonTrace;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const DEFAULT_PYTHON_CONFIG = {
    language: 'python',
    entry_point: 'src/main.py',
    filters: {
        include: ['src'],
        exclude: ['tests', 'venv', '.git', '.idea', '__pycache__']
    }
};
async function initPythonTrace(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const debugDir = path.join(workspaceRoot, '__debug');
    const traceDir = path.join(debugDir, 'trace');
    const instJsonPath = path.join(traceDir, 'inst.json');
    fs.mkdirSync(traceDir, { recursive: true });
    let configData = { ...DEFAULT_PYTHON_CONFIG, workspace_root: workspaceRoot };
    if (fs.existsSync(instJsonPath)) {
        try {
            const content = fs.readFileSync(instJsonPath, 'utf-8');
            const existing = JSON.parse(content);
            if (existing.language === 'python') {
                configData = { ...configData, ...existing };
            }
        }
        catch {
            // Keep defaults when existing config is invalid.
        }
    }
    const panel = vscode.window.createWebviewPanel('visualPilotPythonInstSettings', 'VisualPilot Python Trace Settings', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true
    });
    panel.webview.html = getPythonWebviewContent(configData);
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'selectEntry': {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'Python Files': ['py']
                    },
                    defaultUri: vscode.Uri.file(workspaceRoot)
                });
                if (uris && uris.length > 0) {
                    const selectedAbs = uris[0].fsPath;
                    const relative = path.relative(workspaceRoot, selectedAbs).split(path.sep).join('/');
                    panel.webview.postMessage({
                        command: 'updateEntryPath',
                        path: relative
                    });
                }
                break;
            }
            case 'cancel':
                panel.dispose();
                vscode.window.showInformationMessage('Python trace initialization cancelled.');
                break;
            case 'saveAndRun': {
                try {
                    const parsed = JSON.parse(message.data);
                    const jsonData = parsed.json;
                    if (!jsonData || jsonData.language !== 'python') {
                        vscode.window.showErrorMessage('Invalid Python trace config: language must be python.');
                        return;
                    }
                    if (!jsonData.entry_point || typeof jsonData.entry_point !== 'string') {
                        vscode.window.showErrorMessage('Invalid Python trace config: entry_point is required.');
                        return;
                    }
                    jsonData.workspace_root = workspaceRoot;
                    fs.writeFileSync(instJsonPath, JSON.stringify(jsonData, null, 4), 'utf-8');
                    panel.dispose();
                    vscode.window.showInformationMessage('Python inst.json saved. Running instrumentation...');
                    await vscode.commands.executeCommand('visualPilot.runPythonTrace');
                }
                catch (error) {
                    vscode.window.showErrorMessage(`Failed to save Python settings: ${String(error)}`);
                }
                break;
            }
        }
    }, undefined, context.subscriptions);
}
function getPythonWebviewContent(data) {
    const jsonString = JSON.stringify(data, null, 4);
    const entryPoint = typeof data.entry_point === 'string' ? data.entry_point : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Python Trace Settings</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        .form-group {
            margin-bottom: 15px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        }
        input[type="text"] {
            width: 100%;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        .input-group {
            display: flex;
            gap: 10px;
        }
        .input-group input {
            flex-grow: 1;
        }
        textarea {
            width: 100%;
            height: 340px;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: monospace;
        }
        .buttons {
            margin-top: 20px;
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }
        button {
            padding: 8px 16px;
            border: none;
            cursor: pointer;
            font-size: 14px;
        }
        button.confirm {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button.confirm:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.cancel {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.cancel:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        button.browse {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        details {
            margin-top: 20px;
            border: 1px solid var(--vscode-widget-border);
            padding: 10px;
        }
        summary {
            cursor: pointer;
            font-weight: bold;
            margin-bottom: 10px;
        }
        hr {
            border: 0;
            height: 1px;
            background: var(--vscode-widget-border);
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>VisualPilot Python Trace Settings</h2>

        <div class="form-group">
            <label for="entryPoint">Entry Python File (Relative Path)</label>
            <div class="input-group">
                <input type="text" id="entryPoint" value="${entryPoint}" placeholder="src/main.py">
                <button class="browse" onclick="selectEntry()">Browse...</button>
            </div>
        </div>

        <hr>

        <details>
            <summary>Advanced (JSON Editor)</summary>
            <div class="form-group">
                <textarea id="jsonEditor">${jsonString}</textarea>
            </div>
        </details>

        <div class="buttons">
            <button class="cancel" onclick="cancel()">Cancel</button>
            <button class="confirm" onclick="saveAndRun()">Confirm and Run</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const entryInput = document.getElementById('entryPoint');
        const jsonEditor = document.getElementById('jsonEditor');

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateEntryPath') {
                entryInput.value = message.path;
                syncEntryToJson();
            }
        });

        function selectEntry() {
            vscode.postMessage({ command: 'selectEntry' });
        }

        function syncEntryToJson() {
            try {
                const currentJson = JSON.parse(jsonEditor.value);
                currentJson.entry_point = entryInput.value;
                jsonEditor.value = JSON.stringify(currentJson, null, 4);
            } catch {
                // Keep editor content unchanged if JSON is temporarily invalid.
            }
        }

        entryInput.addEventListener('input', syncEntryToJson);

        jsonEditor.addEventListener('input', () => {
            try {
                const currentJson = JSON.parse(jsonEditor.value);
                if (typeof currentJson.entry_point === 'string') {
                    entryInput.value = currentJson.entry_point;
                }
            } catch {
                // Ignore parse errors while typing.
            }
        });

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        function saveAndRun() {
            try {
                const jsonData = JSON.parse(jsonEditor.value);
                jsonData.entry_point = entryInput.value;
                vscode.postMessage({
                    command: 'saveAndRun',
                    data: JSON.stringify({ json: jsonData })
                });
            } catch (error) {
                console.error('Invalid JSON', error);
            }
        }
    </script>
</body>
</html>`;
}
//# sourceMappingURL=PythonTraceInit.js.map