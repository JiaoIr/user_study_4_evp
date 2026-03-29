import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type LlmPhase = 'debugging' | 'understanding';

const CANDIDATE_JSON_FILES = ['explanation.json', 'llmgeneration.json', 'query.json', 'result.json'];

interface LlmSectionItem {
    key?: string;
    comment?: string;
    content?: string;
    result?: string;
}

interface LlmPayload {
    leftText: string;
    rightText: string;
    label: string;
}

export class LlmGenerationController implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private currentPhase: LlmPhase = 'debugging';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly getActiveCaseRoot?: () => string | undefined
    ) {}

    public async play(): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        const caseRoot = this.getActiveCaseRoot?.() ?? workspaceRoot;
        if (!workspaceRoot || !caseRoot) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        this.ensurePanel(workspaceRoot);
        await this.refreshSource(caseRoot, true);
        this.postPhase();
    }

    public async setPhase(phase: LlmPhase): Promise<void> {
        this.currentPhase = phase;
        this.postPhase();
    }

    public async terminate(showMessage = true): Promise<void> {
        if (showMessage) {
            vscode.window.showInformationMessage('LLM generation panel closed.');
        }
    }

    public async close(): Promise<void> {
        await this.terminate(false);
        this.panel?.dispose();
        this.panel = undefined;
    }

    public dispose(): void {
        void this.terminate(false);
        this.panel?.dispose();
        while (this.disposables.length > 0) {
            const d = this.disposables.pop();
            d?.dispose();
        }
    }

    private ensurePanel(workspaceRoot: string): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'visualPilotLlmGeneration',
            'LLM Generation Explain',
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    this.extensionUri,
                    vscode.Uri.file(workspaceRoot)
                ]
            }
        );

        this.panel.webview.html = this.getWebviewHtml(this.panel.webview);

        const disposeDisposable = this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        const messageDisposable = this.panel.webview.onDidReceiveMessage(async (message: { command?: string }) => {
            if (message.command === 'ready') {
                const caseRoot = this.getActiveCaseRoot?.() ?? workspaceRoot;
                if (caseRoot) {
                    await this.refreshSource(caseRoot, false);
                    this.postPhase();
                }
            }
        });

        this.disposables.push(disposeDisposable, messageDisposable);
    }

    private async refreshSource(caseRoot: string, notifyWhenMissing: boolean): Promise<void> {
        if (!this.panel) {
            return;
        }

        const llmRoot = path.join(caseRoot, '__debug', 'llmgeneration');
        const payload = this.loadPayload(llmRoot);
        if (!payload) {
            if (notifyWhenMissing) {
                vscode.window.showWarningMessage('No readable llmGeneration JSON found in __debug/llmgeneration.');
            }

            this.panel.webview.postMessage({
                command: 'setPayload',
                label: 'No llmGeneration json',
                leftText: '',
                rightText: ''
            });
            return;
        }

        this.panel.webview.postMessage({
            command: 'setPayload',
            label: payload.label,
            leftText: payload.leftText,
            rightText: payload.rightText
        });
    }

    private loadPayload(llmRoot: string): LlmPayload | undefined {
        if (!fs.existsSync(llmRoot) || !fs.statSync(llmRoot).isDirectory()) {
            return undefined;
        }

        const preferred = CANDIDATE_JSON_FILES
            .map((name) => path.join(llmRoot, name))
            .find((p) => fs.existsSync(p));

        const selectedPath = preferred ?? this.findFirstJson(llmRoot);
        if (!selectedPath) {
            return undefined;
        }

        try {
            const raw = JSON.parse(fs.readFileSync(selectedPath, 'utf8'));
            const sections = this.extractSections(raw);
            return {
                leftText: sections.leftText,
                rightText: sections.rightText,
                label: path.basename(selectedPath)
            };
        } catch {
            return undefined;
        }
    }

    private findFirstJson(dir: string): string | undefined {
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return undefined;
        }

        const first = entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
            .map((entry) => path.join(dir, entry.name))
            .sort((a, b) => a.localeCompare(b))[0];

        return first;
    }

    private extractSections(raw: unknown): { leftText: string; rightText: string } {
        if (!raw || typeof raw !== 'object') {
            return { leftText: '', rightText: '' };
        }

        const obj = raw as Record<string, unknown>;
        const leftSection = this.pickNamedSection(obj, ['Question for Debugging', 'Debugging', 'question for debugging', 'debugging']);
        const rightSection = this.pickNamedSection(obj, ['Question for Understanding', 'Understanding', 'question for understanding', 'understanding']);

        if (leftSection || rightSection) {
            return {
                leftText: this.renderSectionText(leftSection),
                rightText: this.renderSectionText(rightSection)
            };
        }

        const normalizedItems = this.collectSectionItems(raw);
        if (normalizedItems.length === 0) {
            return { leftText: '', rightText: '' };
        }

        if (normalizedItems.length === 1) {
            const one = this.renderItem(normalizedItems[0], 1);
            return { leftText: one, rightText: '' };
        }

        const split = Math.ceil(normalizedItems.length / 2);
        const leftItems = normalizedItems.slice(0, split);
        const rightItems = normalizedItems.slice(split);
        return {
            leftText: leftItems.map((item, idx) => this.renderItem(item, idx + 1)).join('\n\n'),
            rightText: rightItems.map((item, idx) => this.renderItem(item, idx + 1)).join('\n\n')
        };
    }

    private pickNamedSection(source: Record<string, unknown>, names: string[]): unknown {
        for (const name of names) {
            const value = source[name];
            if (value !== undefined) {
                return value;
            }
        }

        return undefined;
    }

    private collectSectionItems(section: unknown): LlmSectionItem[] {
        if (!section) {
            return [];
        }

        if (Array.isArray(section)) {
            return section
                .map((item, index) => this.toItem(item, `Q${index + 1}`))
                .filter((item): item is LlmSectionItem => !!item);
        }

        if (typeof section !== 'object') {
            return [];
        }

        const obj = section as Record<string, unknown>;
        const maybeDirect = this.toItem(obj);
        if (maybeDirect) {
            return [maybeDirect];
        }

        const items: LlmSectionItem[] = [];
        for (const key of Object.keys(obj)) {
            const item = this.toItem(obj[key], key);
            if (item) {
                items.push(item);
            }
        }

        return items;
    }

    private toItem(raw: unknown, itemKey?: string): LlmSectionItem | undefined {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return undefined;
        }

        const obj = raw as Record<string, unknown>;
        const key = typeof itemKey === 'string' && itemKey.trim().length > 0
            ? itemKey.trim()
            : (typeof obj.key === 'string' ? obj.key : undefined);
        const content = typeof obj.content === 'string'
            ? obj.content
            : undefined;
        const comment = typeof obj.comment === 'string'
            ? obj.comment
            : undefined;
        const result = typeof obj.result === 'string'
            ? obj.result
            : (typeof obj.answer === 'string' ? obj.answer : undefined);

        if (!key && !content && !comment && !result) {
            return undefined;
        }

        return { key, content, comment, result };
    }

    private renderSectionText(section: unknown): string {
        const items = this.collectSectionItems(section);
        if (items.length === 0) {
            return '';
        }

        return items.map((item, idx) => this.renderItem(item, idx + 1)).join('\n\n');
    }

    private renderItem(item: LlmSectionItem, index: number): string {
        const lines: string[] = [];
        const seq = `Q${index}`;
        const questionText = item.comment?.trim() || item.content?.trim() || '';
        const title = questionText ? `${seq}: ${questionText}` : (item.key?.trim() || seq);
        lines.push(title);
        if (item.result) {
            lines.push(`Result: ${item.result}`);
        }

        return lines.join('\n');
    }

    private postPhase(): void {
        if (!this.panel) {
            return;
        }

        this.panel.webview.postMessage({
            command: 'setPhase',
            phase: this.currentPhase
        });
    }

    private getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }

        return folders[0].uri.fsPath;
    }

    private getWebviewHtml(webview: vscode.Webview): string {
        const nonce = String(Date.now());
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LLM Generation Explain</title>
    <style>
        body {
            margin: 0;
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .header {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .layout {
            flex: 1;
            min-height: 0;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            padding: 8px;
        }

        .panel {
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 8px;
            min-height: 0;
            display: flex;
            flex-direction: column;
            background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-border) 8%);
        }

        .title {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            font-size: 12px;
            font-weight: 600;
        }

        .content {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 10px;
            line-height: 1.5;
            font-size: 12px;
        }

        .content h3 {
            margin: 0 0 8px;
            font-size: 13px;
        }

        .content p {
            margin: 0 0 8px;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .content ul {
            margin: 0 0 10px 16px;
            padding: 0;
        }

        .content li {
            margin: 0 0 6px;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .hidden {
            display: none;
        }

        .placeholder {
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="header">
        <div id="status">Loading...</div>
        <div id="source"></div>
    </div>
    <div class="layout">
        <section class="panel">
            <div class="title">Debugging Related Answer</div>
            <div id="leftContent" class="content placeholder">No content.</div>
        </section>
        <section id="rightPanel" class="panel hidden">
            <div class="title">Understanding Related Answer</div>
            <div id="rightContent" class="content placeholder">Waiting for unlock...</div>
        </section>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const status = document.getElementById('status');
        const source = document.getElementById('source');
        const leftContent = document.getElementById('leftContent');
        const rightPanel = document.getElementById('rightPanel');
        const rightContent = document.getElementById('rightContent');

        let currentPhase = 'debugging';
        let unlockTimer = undefined;
        let payload = {
            leftText: '',
            rightText: ''
        };

        function escapeHtml(text) {
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function inlineFormat(text) {
            return escapeHtml(text).replace(new RegExp('\\\\*\\\\*(.+?)\\\\*\\\\*', 'g'), '<strong>$1</strong>');
        }

        function renderMarkdown(markdownText, emptyMessage) {
            const src = String(markdownText || '').trim();
            if (!src) {
                return '<p class="placeholder">' + escapeHtml(emptyMessage) + '</p>';
            }

            const lines = src.split(new RegExp('\\\\r?\\\\n'));
            const out = [];
            let inList = false;

            const closeList = () => {
                if (inList) {
                    out.push('</ul>');
                    inList = false;
                }
            };

            for (const raw of lines) {
                const line = (typeof raw.trimEnd === 'function') ? raw.trimEnd() : raw.replace(new RegExp('\\\\s+$'), '');
                if (!line.trim()) {
                    closeList();
                    continue;
                }

                if (line.startsWith('### ')) {
                    closeList();
                    out.push('<h3>' + inlineFormat(line.slice(4)) + '</h3>');
                    continue;
                }

                if (line.startsWith('- ')) {
                    if (!inList) {
                        out.push('<ul>');
                        inList = true;
                    }
                    out.push('<li>' + inlineFormat(line.slice(2)) + '</li>');
                    continue;
                }

                closeList();
                out.push('<p>' + inlineFormat(line) + '</p>');
            }

            closeList();
            return out.join('');
        }

        function clearTimer() {
            if (unlockTimer) {
                clearTimeout(unlockTimer);
                unlockTimer = undefined;
            }
        }

        function renderPhase() {
            try {
                clearTimer();

                leftContent.innerHTML = renderMarkdown(payload.leftText, 'No debugging answer.');
                leftContent.classList.toggle('placeholder', !payload.leftText);

                if (currentPhase === 'debugging') {
                    status.textContent = 'Debugging phase: right column hidden';
                    rightPanel.classList.add('hidden');
                    return;
                }

                rightPanel.classList.add('hidden');
                rightContent.innerHTML = '<p class="placeholder">Unlocking understanding answer in 30 seconds...</p>';
                rightContent.classList.add('placeholder');
                status.textContent = 'Understanding phase: waiting 30 seconds';

                unlockTimer = setTimeout(() => {
                    rightPanel.classList.remove('hidden');
                    rightContent.innerHTML = renderMarkdown(payload.rightText, 'No understanding answer.');
                    rightContent.classList.toggle('placeholder', !payload.rightText);
                    status.textContent = 'Understanding answer unlocked';
                }, 30000);
            } catch (error) {
                status.textContent = 'Render failed';
                const message = (error && error.message) ? error.message : String(error);
                leftContent.innerHTML = '<p class="placeholder">Render error: ' + escapeHtml(message) + '</p>';
                rightPanel.classList.add('hidden');
            }
        }

        window.addEventListener('message', (event) => {
            const message = event.data;

            if (message.command === 'setPayload') {
                payload = {
                    leftText: String(message.leftText || ''),
                    rightText: String(message.rightText || '')
                };
                source.textContent = String(message.label || '');
                status.textContent = 'Content loaded';
                renderPhase();
                return;
            }

            if (message.command === 'setPhase') {
                currentPhase = message.phase === 'understanding' ? 'understanding' : 'debugging';
                renderPhase();
            }
        });

        window.addEventListener('beforeunload', () => {
            clearTimer();
        });

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
