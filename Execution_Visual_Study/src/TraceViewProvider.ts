import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface DataFlowRecord {
    type: string;
    name: string;
    value: string | any; // 支持数组等复杂类型
    id: string;
    depth?: number; // 树形层级，默认为0
}

interface TraceItem {
    id: number;
    src: string;
    line: number;
    method_name: string;   // 方法名,替代文件名显示
    status?: number;       // 影响力指标(0-1),用于标注ID背景色
    depth?: number;        // 树形层级,用于调用栈展示
    children?: TraceItem[]; // 子节点,用于树形结构
    read?: DataFlowRecord[];  // 读取的数据流记录
    written?: DataFlowRecord[]; // 写入的数据流记录
}

interface BlockInfo {
    id: number;
    startline: number;
    endline: number;
}

interface TraceData {
    trace: TraceItem[];
    blocks: BlockInfo[];
}

export interface PlaybackLinkBlock {
    id: number;
    name: string;
    start: number;
    end: number;
    tstart?: number;
    tend?: number;
    cstart?: number;
    cend?: number;
    file?: string;
}

interface PlaybackDecorationSet {
    single: vscode.TextEditorDecorationType;
    top: vscode.TextEditorDecorationType;
    middle: vscode.TextEditorDecorationType;
    bottom: vscode.TextEditorDecorationType;
}

const PLAYBACK_BLOCK_COLORS = [
    '#ff6b6b',
    '#4ecdc4',
    '#45b7d1',
    '#96ceb4',
    '#feca57',
    '#ff9ff3',
    '#54a0ff',
    '#48dbfb'
];

export class TraceViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ttdTraceView';
    
    private _view?: vscode.WebviewView;
    private workspaceRoot: string;
    private traceData: TraceItem[] = [];
    private blockData: BlockInfo[] = [];
    private decorationType: vscode.TextEditorDecorationType;
    private playbackDecorationTypes: PlaybackDecorationSet[] = [];
    private playbackFilePath?: string;
    private fileWatcher?: vscode.FileSystemWatcher;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly getActiveCaseRoot?: () => string | undefined,
        private readonly getActiveSourceCaseRoot?: () => string | undefined,
    ) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        this.workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
        
        // 创建高亮装饰器
        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 255, 0, 0.3)',
            border: '2px solid yellow',
            isWholeLine: true
        });

        this.playbackDecorationTypes = PLAYBACK_BLOCK_COLORS.map((hexColor) => {
            const fillColor = this.hexToRgba(hexColor, 0.22);
            return {
                single: vscode.window.createTextEditorDecorationType({
                    backgroundColor: fillColor,
                    border: `1px solid ${hexColor}`,
                    isWholeLine: true,
                    overviewRulerColor: hexColor,
                    overviewRulerLane: vscode.OverviewRulerLane.Full
                }),
                top: vscode.window.createTextEditorDecorationType({
                    backgroundColor: fillColor,
                    borderWidth: '1px 1px 0 1px',
                    borderStyle: 'solid',
                    borderColor: hexColor,
                    isWholeLine: true
                }),
                middle: vscode.window.createTextEditorDecorationType({
                    backgroundColor: fillColor,
                    borderWidth: '0 1px 0 1px',
                    borderStyle: 'solid',
                    borderColor: hexColor,
                    isWholeLine: true
                }),
                bottom: vscode.window.createTextEditorDecorationType({
                    backgroundColor: fillColor,
                    borderWidth: '0 1px 1px 1px',
                    borderStyle: 'solid',
                    borderColor: hexColor,
                    isWholeLine: true
                })
            };
        });

        // 监听 trace 文件变化
        this.setupFileWatcher();
    }

    private setupFileWatcher() {
        if (!this.workspaceRoot) {
            return;
        }

        // 监听 __debug 目录下所有的 trace.json
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, '**/__debug/**/trace.json')
        );

        this.fileWatcher.onDidChange(() => {
            this.loadTraceData();
        });

        this.fileWatcher.onDidCreate(() => {
            this.loadTraceData();
        });

        this.fileWatcher.onDidDelete(() => {
            // 文件删除时重新加载，以检查是否有备用文件
            this.loadTraceData();
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // 处理来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'navigateToLine':
                    await this.navigateToLine(message.src, message.line);
                    break;
                case 'ready':
                    // WebView 准备就绪，加载数据
                    this.loadTraceData();
                    break;
                case 'goButtonClicked':
                    // 处理 Go 按钮点击事件
                    // TODO: 实现具体的功能
                    console.log('Go button clicked with option:', message.option);
                    break;
            }
        });

        // 初始加载数据
        this.loadTraceData();
    }

    public refresh() {
        this.loadTraceData();
    }

    public clearTraceData(): void {
        this.traceData = [];
        this.blockData = [];
        this.updateWebview('None');
        this.clearPlaybackHighlight();
    }

    public selectTraceStep(traceId: number) {
        // 发送消息到 webview 选中对应的 trace step
        if (this._view) {
            this._view.webview.postMessage({
                command: 'selectTraceStep',
                traceId: traceId
            });
        }
    }

    public async highlightPlaybackBlock(block: PlaybackLinkBlock): Promise<void> {
        const colorIndex = ((block.id % PLAYBACK_BLOCK_COLORS.length) + PLAYBACK_BLOCK_COLORS.length) % PLAYBACK_BLOCK_COLORS.length;

        if (this._view) {
            this._view.webview.postMessage({
                command: 'highlightPlaybackBlock',
                tstart: block.tstart,
                tend: block.tend,
                colorIndex
            });
        }

        if (typeof block.tstart === 'number') {
            this.selectTraceStep(block.tstart);
        }

        await this.highlightCodeRanges([{ block, colorIndex }]);
    }

    public async showAllPlaybackBlocks(blocks: PlaybackLinkBlock[]): Promise<void> {
        const mapped = blocks
            .filter((block) => typeof block.tstart === 'number' && typeof block.tend === 'number')
            .map((block) => ({
                tstart: block.tstart,
                tend: block.tend,
                colorIndex: ((block.id % PLAYBACK_BLOCK_COLORS.length) + PLAYBACK_BLOCK_COLORS.length) % PLAYBACK_BLOCK_COLORS.length
            }));

        if (this._view) {
            this._view.webview.postMessage({
                command: 'showAllPlaybackBlocks',
                ranges: mapped
            });
        }

        await this.highlightCodeRanges(
            blocks.map((block) => ({
                block,
                colorIndex: ((block.id % PLAYBACK_BLOCK_COLORS.length) + PLAYBACK_BLOCK_COLORS.length) % PLAYBACK_BLOCK_COLORS.length
            }))
        );
    }

    public clearPlaybackHighlight(): void {
        if (this._view) {
            this._view.webview.postMessage({
                command: 'clearPlaybackHighlight'
            });
        }

        this.clearCodePlaybackDecorations();
        this.playbackFilePath = undefined;
    }

    private async loadTraceData() {
        const activeRoot = this.getActiveCaseRoot?.() ?? this.workspaceRoot;

        if (!activeRoot) {
            vscode.window.showWarningMessage('No workspace folder is open.');
            return;
        }

        try {
            const debugPilotTracePath = path.join(activeRoot, '__debug', 'debugpilot', 'trace.json');
            const tracePath = path.join(activeRoot, '__debug', 'trace', 'trace.json');
            
            let activePath = '';
            let sourceName = '';

            // 优先读取 debugpilot 下的 trace
            if (fs.existsSync(debugPilotTracePath)) {
                activePath = debugPilotTracePath;
                sourceName = 'DebugPilot';
            } else if (fs.existsSync(tracePath)) {
                activePath = tracePath;
                sourceName = 'Trace';
            } else {
                this.traceData = [];
                this.blockData = [];
                this.updateWebview('None');
                return;
            }

            const fileContent = fs.readFileSync(activePath, 'utf8');
            const jsonData = JSON.parse(fileContent);
            
            // 兼容新旧格式
            if (jsonData.trace && Array.isArray(jsonData.trace)) {
                // 新格式: { trace: [...], blocks: [...] }
                this.traceData = jsonData.trace;
                this.blockData = jsonData.blocks || [];
            } else if (Array.isArray(jsonData)) {
                // 旧格式: [...]
                this.traceData = jsonData;
                this.blockData = [];
            } else {
                throw new Error('Invalid trace.json format');
            }
            
            this.updateWebview(sourceName);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load trace.json: ${error}`);
            this.traceData = [];
            this.blockData = [];
            this.updateWebview('Error');
        }
    }

    private updateWebview(source: string = '') {
        if (this._view) {
            this._view.webview.postMessage({
                command: 'updateTrace',
                data: this.traceData,
                blocks: this.blockData,
                source: source
            });
        }
    }

    private async highlightCodeRanges(
        entries: Array<{ block: PlaybackLinkBlock; colorIndex: number }>
    ): Promise<void> {
        const validEntries = entries.filter(({ block }) =>
            !!block.file &&
            typeof block.cstart === 'number' &&
            typeof block.cend === 'number' &&
            block.cstart > 0 &&
            block.cend >= block.cstart
        );

        if (validEntries.length === 0) {
            this.clearCodePlaybackDecorations();
            this.playbackFilePath = undefined;
            return;
        }

        const filePath = this.resolveSourceFilePath(validEntries[0].block.file as string);

        if (!filePath || !fs.existsSync(filePath)) {
            this.clearCodePlaybackDecorations();
            this.playbackFilePath = undefined;
            return;
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: true,
            preview: true
        });

        this.clearCodePlaybackDecorations();

        for (let idx = 0; idx < this.playbackDecorationTypes.length; idx += 1) {
            const set = this.playbackDecorationTypes[idx];
            const singles: vscode.Range[] = [];
            const tops: vscode.Range[] = [];
            const middles: vscode.Range[] = [];
            const bottoms: vscode.Range[] = [];

            for (const entry of validEntries) {
                if (entry.colorIndex !== idx) {
                    continue;
                }

                const startLine = Math.max(0, (entry.block.cstart as number) - 1);
                const endLine = Math.max(startLine, (entry.block.cend as number) - 1);

                if (startLine === endLine) {
                    singles.push(new vscode.Range(startLine, 0, endLine, 0));
                } else {
                    tops.push(new vscode.Range(startLine, 0, startLine, 0));
                    if (endLine - startLine > 1) {
                        middles.push(new vscode.Range(startLine + 1, 0, endLine - 1, 0));
                    }
                    bottoms.push(new vscode.Range(endLine, 0, endLine, 0));
                }
            }

            editor.setDecorations(set.single, singles);
            editor.setDecorations(set.top, tops);
            editor.setDecorations(set.middle, middles);
            editor.setDecorations(set.bottom, bottoms);
        }

        const revealEntry = validEntries[0].block;
        const revealRange = new vscode.Range(
            Math.max(0, (revealEntry.cstart as number) - 1),
            0,
            Math.max(0, (revealEntry.cend as number) - 1),
            0
        );
        editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.playbackFilePath = document.uri.fsPath;
    }

    private clearCodePlaybackDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            for (const set of this.playbackDecorationTypes) {
                editor.setDecorations(set.single, []);
                editor.setDecorations(set.top, []);
                editor.setDecorations(set.middle, []);
                editor.setDecorations(set.bottom, []);
            }
        }
    }

    private hexToRgba(hexColor: string, alpha: number): string {
        const hex = hexColor.replace('#', '');
        if (hex.length !== 6) {
            return `rgba(255, 255, 0, ${alpha})`;
        }

        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    private async navigateToLine(src: string, line: number) {
        try {
            const filePath = this.resolveSourceFilePath(src);
            if (!filePath) {
                vscode.window.showErrorMessage(`File not found: ${src}`);
                return;
            }
            const uri = vscode.Uri.file(filePath);

            // 检查文件是否存在
            if (!fs.existsSync(filePath)) {
                vscode.window.showErrorMessage(`File not found: ${src}`);
                return;
            }

            // 打开文档
            const document = await vscode.workspace.openTextDocument(uri);
            
            // 在编辑器中显示文档（明确指定在左侧编辑器组打开，不在右侧 Debug Details 组）
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.One, // 明确指定在左侧编辑器组
                preserveFocus: false,
                preview: false
            });

            // 跳转到指定行（VSCode 行号从 0 开始，所以要减 1）
            const position = new vscode.Position(Math.max(0, line - 1), 0);
            const range = new vscode.Range(position, position);

            // 设置选择和显示范围
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

            // 清除之前的高亮
            vscode.window.visibleTextEditors.forEach(e => {
                e.setDecorations(this.decorationType, []);
            });

            // 高亮当前行
            editor.setDecorations(this.decorationType, [range]);

            // 3秒后清除高亮
            setTimeout(() => {
                if (editor) {
                    editor.setDecorations(this.decorationType, []);
                }
            }, 3000);

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to navigate to ${src}:${line} - ${error}`);
        }
    }

    private resolveSourceFilePath(fileValue: string): string | undefined {
        const normalized = String(fileValue ?? '').trim();
        if (!normalized) {
            return undefined;
        }

        if (path.isAbsolute(normalized)) {
            return normalized;
        }

        const sourceRoot = this.getActiveSourceCaseRoot?.() ?? this.workspaceRoot;
        const relativeNormalized = normalized.replace(/[\\/]+/g, path.sep);
        return path.join(sourceRoot, relativeNormalized);
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TTD Trace</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 0;
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .main-container {
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
        }

        .trace-list-section {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            transition: bottom 0.2s ease;
        }

        /* Hide Step Properties panel completely. */
        .resizer,
        .dataflow-section {
            display: none !important;
        }

        .header {
            padding: 8px 12px;
            background-color: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
            font-weight: 600;
            color: var(--vscode-sideBarTitle-foreground);
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
        }

        .header-title {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .trace-count {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            font-weight: normal;
        }

        .trace-source {
            font-size: 0.8em;
            color: var(--vscode-textLink-foreground);
            margin-left: 4px;
            font-weight: normal;
        }

        .trace-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: auto;
        }

        /* 分割线样式 */
        .resizer {
            height: 4px;
            background-color: var(--vscode-sideBarSectionHeader-border);
            cursor: ns-resize;
            position: relative;
            flex-shrink: 0;
            transition: background-color 0.1s ease;
        }

        .resizer:hover {
            background-color: var(--vscode-focusBorder);
        }

        .resizer:active {
            background-color: var(--vscode-focusBorder);
        }

        /* 折叠时禁用分割线拖拽 */
        .resizer.collapsed {
            cursor: default;
            pointer-events: none;
        }

        /* 数据流面板样式 */
        .dataflow-section {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 30%; /* 默认展开时的高度，可调整 */
            display: flex;
            flex-direction: column;
            transition: height 0.2s ease;
        }

        .dataflow-header {
            padding: 8px 12px;
            background-color: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
            font-weight: 600;
            color: var(--vscode-sideBarTitle-foreground);
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
            cursor: pointer;
            user-select: none;
        }

        .dataflow-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .dataflow-toggle {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-icon-foreground);
            font-size: 11px;
            transition: transform 0.2s ease;
            transform: rotate(90deg);
            margin-right: 6px;
        }

        .dataflow-toggle.collapsed {
            transform: rotate(0deg);
        }

        .dataflow-toggle::before {
            content: '▶';
        }

        .dataflow-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 12px;
            transition: all 0.2s ease;
        }

        .dataflow-section.collapsed .dataflow-container {
            display: none;
        }

        /* 折叠时，只显示标题栏，固定高度 */
        .dataflow-section.collapsed {
            height: 32px;
        }

        /* 折叠时，trace list 占据剩余空间 */
        .trace-list-section.expanded {
            bottom: 32px;
        }

        .main-container {
            position: relative;
        }


        .dataflow-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            text-align: center;
        }

        .dataflow-empty-icon {
            font-size: 2em;
            margin-bottom: 10px;
            opacity: 0.5;
        }

        #trace-list {
            list-style: none;
            padding: 0;
            margin: 0;
            min-width: max-content;
        }

        /* 精简为单行显示 - 适配 1k-10k 规模 */
        .trace-item {
            padding: 4px 8px;
            cursor: pointer;
            transition: all 0.1s ease;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.85em;
            line-height: 1.4;
            min-height: 24px;
            position: relative;
            border: 0 solid transparent;
            margin: 0;
            white-space: nowrap;
        }

        .trace-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .trace-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
        }

        .trace-item.selected:hover {
            background-color: var(--vscode-list-activeSelectionBackground);
        }

        /* 树形展开按钮 - 为层级化预留 */
        .trace-expand {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: var(--vscode-icon-foreground);
            font-size: 11px;
            flex-shrink: 0;
            user-select: none;
            opacity: 0.8;
            transition: transform 0.1s ease;
        }

        .trace-expand:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
            border-radius: 3px;
        }

        .trace-expand.empty {
            opacity: 0;
            pointer-events: none;
        }

        .trace-item.has-children .trace-expand {
            display: flex;
        }

        .trace-expand.expanded {
            transform: rotate(90deg);
        }

        .trace-expand::before {
            content: '▶';
        }

        /* 隐藏折叠的子节点 */
        .trace-item.collapsed {
            display: none;
        }

        /* 紧凑的 ID 标签 - 根据 status 动态着色 */
        .trace-id {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.8em;
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            padding: 1px 4px;
            border-radius: 2px;
            min-width: 28px;
            text-align: center;
            flex-shrink: 0;
        }

        /* 方法名 + 行号在同一行 */
        .trace-info {
            display: flex;
            align-items: baseline;
            gap: 4px;
            white-space: nowrap;
        }

        .trace-method {
            color: var(--vscode-foreground);
            white-space: nowrap;
        }

        .trace-line {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }

        /* Block 边框样式 - 四周矩形框 */
        /* 八种颜色用于不同的 blocks */
        .trace-item.block-border-top { 
            border-top-width: 2px; 
            border-top-style: solid;
        }
        .trace-item.block-border-bottom { 
            border-bottom-width: 2px; 
            border-bottom-style: solid;
        }
        .trace-item.block-border-left { 
            border-left-width: 2px; 
            border-left-style: solid;
        }
        .trace-item.block-border-right { 
            border-right-width: 2px; 
            border-right-style: solid;
        }

        /* 八种 block 颜色 */
        .trace-item.block-color-0 { border-color: #ff6b6b; }
        .trace-item.block-color-1 { border-color: #4ecdc4; }
        .trace-item.block-color-2 { border-color: #45b7d1; }
        .trace-item.block-color-3 { border-color: #96ceb4; }
        .trace-item.block-color-4 { border-color: #feca57; }
        .trace-item.block-color-5 { border-color: #ff9ff3; }
        .trace-item.block-color-6 { border-color: #54a0ff; }
        .trace-item.block-color-7 { border-color: #48dbfb; }

        .trace-item.playback-active {
            border-left-width: 3px;
            border-left-style: solid;
        }

        .trace-item.playback-color-0 { border-left-color: #ff6b6b; background-color: rgba(255, 107, 107, 0.16); }
        .trace-item.playback-color-1 { border-left-color: #4ecdc4; background-color: rgba(78, 205, 196, 0.16); }
        .trace-item.playback-color-2 { border-left-color: #45b7d1; background-color: rgba(69, 183, 209, 0.16); }
        .trace-item.playback-color-3 { border-left-color: #96ceb4; background-color: rgba(150, 206, 180, 0.16); }
        .trace-item.playback-color-4 { border-left-color: #feca57; background-color: rgba(254, 202, 87, 0.16); }
        .trace-item.playback-color-5 { border-left-color: #ff9ff3; background-color: rgba(255, 159, 243, 0.16); }
        .trace-item.playback-color-6 { border-left-color: #54a0ff; background-color: rgba(84, 160, 255, 0.16); }
        .trace-item.playback-color-7 { border-left-color: #48dbfb; background-color: rgba(72, 219, 251, 0.16); }

        .trace-header {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .trace-line::before {
            content: "→ Line ";
            color: var(--vscode-descriptionForeground);
        }

        .empty-message {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }

        .empty-icon {
            font-size: 2em;
            margin-bottom: 10px;
            opacity: 0.5;
        }

        .loading {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }

        /* 滚动条优化 */
        .trace-container::-webkit-scrollbar {
            width: 8px;
        }

        .trace-container::-webkit-scrollbar-track {
            background: var(--vscode-scrollbarSlider-background);
        }

        .trace-container::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-hoverBackground);
            border-radius: 4px;
        }

        .trace-container::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-activeBackground);
        }

        .dataflow-container::-webkit-scrollbar {
            width: 8px;
        }

        .dataflow-container::-webkit-scrollbar-track {
            background: var(--vscode-scrollbarSlider-background);
        }

        .dataflow-container::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-hoverBackground);
            border-radius: 4px;
        }

        .dataflow-container::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-activeBackground);
        }

        /* Step Properties 样式 - 紧凑版 */
        .step-properties-content {
            padding: 0;
        }

        .properties-section {
            margin-bottom: 0;
        }

        .properties-divider {
            height: 1px;
            background-color: var(--vscode-panel-border);
            margin: 0;
        }

        .properties-toolbar {
            padding: 4px 8px;
            background-color: var(--vscode-sideBar-background);
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .toolbar-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .toolbar-option {
            display: flex;
            align-items: center;
            gap: 4px;
            cursor: pointer;
            user-select: none;
            padding: 2px 6px;
            border-radius: 3px;
            transition: background-color 0.1s ease;
        }

        .toolbar-option:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .toolbar-radio {
            width: 12px;
            height: 12px;
            border: 1.5px solid var(--vscode-descriptionForeground);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.1s ease;
        }

        .toolbar-radio.selected {
            border-color: var(--vscode-focusBorder);
        }

        .toolbar-radio.selected::after {
            content: '';
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background-color: var(--vscode-focusBorder);
        }

        .toolbar-label {
            font-size: 0.85em;
            color: var(--vscode-foreground);
        }

        .toolbar-button {
            padding: 2px 10px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.85em;
            transition: background-color 0.1s ease;
        }

        .toolbar-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .toolbar-button:active {
            background-color: var(--vscode-button-hoverBackground);
            opacity: 0.8;
        }

        .variables-section {
            padding: 6px 8px;
        }

        .variables-title {
            font-weight: 600;
            color: var(--vscode-sideBarTitle-foreground);
            margin-bottom: 4px;
            font-size: 0.85em;
        }

        .variables-table-wrapper {
            overflow-y: auto;
            overflow-x: auto;
            /* 固定高度：表头(~22px) + 3行数据(3 * ~19px) = ~79px */
            height: 79px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
        }

        .variables-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.8em;
        }

        .variables-table thead {
            background-color: var(--vscode-sideBarSectionHeader-background);
            position: sticky;
            top: 0;
            z-index: 1;
        }

        .variables-table th {
            padding: 4px 6px;
            text-align: left;
            font-weight: 600;
            color: var(--vscode-sideBarTitle-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            white-space: nowrap;
            line-height: 1.4;
        }

        .variables-table td {
            padding: 3px 6px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
            white-space: nowrap;
            line-height: 1.4;
        }

        .variables-table tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .variables-table tbody tr:last-child td {
            border-bottom: none;
        }

        /* 树形表格样式 */
        .var-row {
            transition: background-color 0.1s ease;
        }

        .var-row.collapsed {
            display: none;
        }

        .var-name-cell {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .var-expand {
            width: 14px;
            height: 14px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: var(--vscode-icon-foreground);
            font-size: 10px;
            flex-shrink: 0;
            user-select: none;
            opacity: 0.8;
            transition: transform 0.1s ease;
        }

        .var-expand:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
            border-radius: 2px;
        }

        .var-expand.empty {
            opacity: 0;
            pointer-events: none;
        }

        .var-expand.expanded {
            transform: rotate(90deg);
        }

        .var-expand::before {
            content: '▶';
        }

        .var-name-text {
            flex: 1;
        }

        .variables-empty {
            padding: 12px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 0.8em;
        }
    </style>
</head>
<body>
    <div class="main-container">
        <!-- 上部分：Trace List -->
        <div class="trace-list-section" id="trace-list-section">
            <div class="header">
                <div class="header-title">
                    <span>📊 Trace Timeline</span>
                    <span class="trace-count" id="trace-count"></span>
                    <span class="trace-source" id="trace-source"></span>
                </div>
            </div>
            
            <div class="trace-container">
                <div id="loading" class="loading">Loading trace data...</div>
                <ul id="trace-list"></ul>
                <div id="empty-message" class="empty-message" style="display: none;">
                    <div class="empty-icon">📝</div>
                    <div>No trace data available</div>
                    <div style="font-size: 0.85em; margin-top: 8px; opacity: 0.7;">
                        Waiting for trace data in <code>__debug/trace/trace.json</code> or <code>__debug/debugpilot/trace.json</code>
                    </div>
                </div>
            </div>
        </div>

        <!-- 可拖拽的分割线 -->
        <div class="resizer" id="resizer"></div>

        <!-- 下部分：Step Properties -->
        <div class="dataflow-section" id="dataflow-section">
            <div class="dataflow-header" id="dataflow-header">
                <div class="header-title">
                    <span class="dataflow-toggle" id="dataflow-toggle"></span>
                    <span>Step Properties</span>
                </div>
            </div>
            
            <div class="dataflow-container" id="dataflow-container">
                <div class="dataflow-empty">
                    <div class="dataflow-empty-icon">📊</div>
                    <div>Select a trace item to view step properties</div>
                    <div style="font-size: 0.85em; margin-top: 8px; opacity: 0.7;">
                        Data flow information will be displayed here
                    </div>
                    </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentSelectedId = null;
        let treeData = []; // 存储树形结构
        let expandedIds = new Set(); // 存储展开的节点 ID
        let blocksData = []; // 存储 blocks 信息
        let playbackRange = null;
        let playbackRanges = [];

        // 初始化分割线拖拽功能
        initResizer();

        // 初始化数据流面板折叠功能
        initDataflowToggle();

        // 通知扩展 WebView 已准备就绪
        vscode.postMessage({ command: 'ready' });

        function initResizer() {
            const resizer = document.getElementById('resizer');
            const traceListSection = document.getElementById('trace-list-section');
            const dataflowSection = document.getElementById('dataflow-section');
            const mainContainer = document.querySelector('.main-container');
            
            let isResizing = false;
            let startY = 0;
            let startHeight = 0;

            // 设置初始比例 3:1 (75% : 25%)
            const savedRatio = getSavedRatio();
            setRatio(savedRatio);

            resizer.addEventListener('mousedown', (e) => {
                isResizing = true;
                startY = e.clientY;
                startHeight = traceListSection.offsetHeight;
                
                // 添加全局样式防止选中文本
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'ns-resize';
                
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                
                const deltaY = e.clientY - startY;
                const newHeight = startHeight + deltaY;
                const containerHeight = mainContainer.offsetHeight;
                const resizerHeight = resizer.offsetHeight;
                
                // 只限制最小高度，确保两个面板都可见
                const minHeight = 40; // 最小高度为标题栏高度
                const maxHeight = containerHeight - 40; // 确保下方面板至少显示标题栏
                
                if (newHeight >= minHeight && newHeight <= maxHeight) {
                    const ratio = newHeight / containerHeight;
                    setRatio(ratio);
                }
                
                e.preventDefault();
            });

            document.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    document.body.style.userSelect = '';
                    document.body.style.cursor = '';
                    
                    // 保存当前比例
                    const ratio = traceListSection.offsetHeight / mainContainer.offsetHeight;
                    saveRatio(ratio);
                }
            });

            function setRatio(ratio) {
                const percentage = (ratio * 100).toFixed(2);
                traceListSection.style.flex = \`0 0 \${percentage}%\`;
                dataflowSection.style.flex = '1';
            }

            function getSavedRatio() {
                const state = vscode.getState();
                return state?.splitRatio || 0.75; // 默认 3:1
            }

            function saveRatio(ratio) {
                vscode.setState({ 
                    ...vscode.getState(),
                    splitRatio: ratio 
                });
            }
        }

        function initDataflowToggle() {
            const dataflowHeader = document.getElementById('dataflow-header');
            const dataflowSection = document.getElementById('dataflow-section');
            const dataflowToggle = document.getElementById('dataflow-toggle');
            const resizer = document.getElementById('resizer');
            const traceListSection = document.getElementById('trace-list-section');

            // 恢复保存的折叠状态
            const isCollapsed = getSavedCollapseState();
            if (isCollapsed) {
                collapseDataflow();
            }

            dataflowHeader.addEventListener('click', () => {
                const wasCollapsed = dataflowSection.classList.contains('collapsed');
                
                if (wasCollapsed) {
                    expandDataflow();
                } else {
                    collapseDataflow();
                }
                
                // 保存状态
                saveCollapseState(!wasCollapsed);
            });

            function collapseDataflow() {
                // 折叠数据流面板
                dataflowSection.classList.add('collapsed');
                dataflowToggle.classList.add('collapsed');
                
                resizer.classList.add('collapsed');
                
                // trace list 占据全部空间
                traceListSection.classList.add('expanded');
            }

            function expandDataflow() {
                // 展开数据流面板
                dataflowSection.classList.remove('collapsed');
                dataflowToggle.classList.remove('collapsed');
                
                // 分割线恢复正常位置
                resizer.classList.remove('collapsed');
                
                // trace list 恢复保存的比例
                traceListSection.classList.remove('expanded');
            }

            function getSavedRatio() {
                const state = vscode.getState();
                return state?.splitRatio || 0.75; // 默认 3:1
            }

            function getSavedCollapseState() {
                const state = vscode.getState();
                return state?.dataflowCollapsed || false;
            }

            function saveCollapseState(collapsed) {
                vscode.setState({ 
                    ...vscode.getState(),
                    dataflowCollapsed: collapsed 
                });
            }
        }

        // 监听来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateTrace':
                    blocksData = message.blocks || [];
                    renderTraceList(message.data);
                    updateSourceDisplay(message.source);
                    break;
                case 'highlightPlaybackBlock':
                    if (typeof message.tstart === 'number' && typeof message.tend === 'number') {
                        playbackRange = {
                            tstart: message.tstart,
                            tend: message.tend,
                            colorIndex: Number(message.colorIndex || 0) % 8
                        };
                        playbackRanges = [playbackRange];
                    } else {
                        playbackRange = null;
                        playbackRanges = [];
                    }
                    renderTree();
                    break;
                case 'showAllPlaybackBlocks':
                    playbackRange = null;
                    playbackRanges = Array.isArray(message.ranges)
                        ? message.ranges.filter(r => typeof r?.tstart === 'number' && typeof r?.tend === 'number')
                        : [];
                    renderTree();
                    break;
                case 'clearPlaybackHighlight':
                    playbackRange = null;
                    playbackRanges = [];
                    renderTree();
                    break;
                case 'selectTraceStep':
                    // 选中指定的 trace step
                    selectTraceStepById(message.traceId);
                    break;
            }
        });

        function updateSourceDisplay(source) {
            const sourceEl = document.getElementById('trace-source');
            if (sourceEl) {
                if (source && source !== 'None' && source !== 'Error') {
                    sourceEl.textContent = \`[\${source}]\`;
                    sourceEl.style.display = 'inline';
                } else {
                    sourceEl.style.display = 'none';
                }
            }
        }

        // 根据 depth 构建树形结构
        function buildTree(flatData) {
            if (!flatData || flatData.length === 0) return [];
            
            const result = [];
            const stack = []; // 用于维护当前路径的栈，存储 { ...item }
            
            flatData.forEach((item, index) => {
                const depth = item.depth !== undefined ? item.depth : 0;
                
                // 为每个节点添加必要的属性
                const node = {
                    ...item,
                    depth: depth,
                    children: [],
                    index: index // 保存原始索引
                };
                
                // 找到正确的父节点：栈顶元素的 depth 必须小于当前节点的 depth
                // 如果栈顶 depth >= 当前 depth，说明栈顶是兄弟节点或已完成的子调用，需要弹出
                while (stack.length > 0) {
                    const top = stack[stack.length - 1];
                    if (top.depth < depth) {
                        break;
                    }
                    stack.pop();
                }
                
                if (stack.length > 0) {
                    // 栈顶即为父节点
                    const parent = stack[stack.length - 1];
                    parent.children.push(node);
                } else {
                    // 栈为空，当前节点为根节点
                    result.push(node);
                }
                
                // 将当前节点入栈，作为后续可能的父节点
                stack.push(node);
            });
            
            return result;
        }

        // 将树形结构扁平化为可渲染的列表
        function flattenTree(tree, parentExpanded = true, parentDepth = -1) {
            const result = [];
            
            tree.forEach(node => {
                const shouldShow = parentDepth === -1 || parentExpanded;
                
                if (shouldShow) {
                    const isExpanded = expandedIds.has(node.id);
                    const hasChildren = node.children && node.children.length > 0;
                    
                    result.push({
                        ...node,
                        hasChildren: hasChildren,
                        expanded: isExpanded
                    });
                    
                    // 递归处理子节点
                    if (hasChildren) {
                        const childrenFlat = flattenTree(node.children, isExpanded, node.depth);
                        result.push(...childrenFlat);
                    }
                }
            });
            
            return result;
        }

        function renderTraceList(traceData) {
            const loading = document.getElementById('loading');
            const traceList = document.getElementById('trace-list');
            const emptyMessage = document.getElementById('empty-message');
            const traceCount = document.getElementById('trace-count');

            loading.style.display = 'none';

            if (!traceData || traceData.length === 0) {
                emptyMessage.style.display = 'block';
                traceList.style.display = 'none';
                traceCount.textContent = '';
                return;
            }

            emptyMessage.style.display = 'none';
            traceList.style.display = 'block';
            traceCount.textContent = \`(\${traceData.length})\`;

            // 构建树形结构
            treeData = buildTree(traceData);
            
            // 渲染
            renderTree();
        }

        // 选中指定的 trace step
        function selectTraceStepById(traceId) {
            console.log('Attempting to select trace step:', traceId);
            
            // 展开所有父节点（通过递归查找父节点并展开）
            const parentsExpanded = expandParentsOfItem(traceId);
            
            if (!parentsExpanded) {
                console.warn(\`Trace step with id \${traceId} not found in tree\`);
                // 即使在树中没找到，也尝试在扁平数据中查找
                const flatData = flattenTree(treeData);
                const targetItem = flatData.find(item => item.id === traceId);
                if (!targetItem) {
                    console.warn(\`Trace step with id \${traceId} not found in flat data either\`);
                    return;
                }
            }
            
            console.log('Parents expanded, now rendering tree');
            
            // 重新渲染树
            renderTree();
            
            // 重新从渲染后的数据中获取 targetItem
            const flatData = flattenTree(treeData);
            const targetItem = flatData.find(item => item.id === traceId);
            
            if (!targetItem) {
                console.warn(\`Trace step with id \${traceId} not found after rendering\`);
                return;
            }
            
            console.log('Target item found:', targetItem);
            
            // 使用 setTimeout 确保 DOM 已经渲染完成
            setTimeout(() => {
                // 查找并选中对应的 DOM 元素
                const targetElement = document.querySelector(\`.trace-item[data-id="\${traceId}"]\`);
                console.log('Target DOM element:', targetElement);
                
                if (targetElement) {
                    // 清除之前的选中状态
                    document.querySelectorAll('.trace-item').forEach(el => {
                        el.classList.remove('selected');
                    });
                    
                    // 选中目标元素
                    targetElement.classList.add('selected');
                    currentSelectedId = traceId;
                    
                    // 滚动到可见区域
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    
                    // 更新数据流面板
                    updateDataflowPanel(targetItem);
                    
                    // 发送消息给扩展导航到对应文件行
                    vscode.postMessage({
                        command: 'navigateToLine',
                        src: targetItem.src,
                        line: targetItem.line
                    });
                    
                    console.log('Successfully selected trace step:', traceId);
                } else {
                    console.error('Target DOM element not found after rendering');
                }
            }, 50);
        }
        
        // 展开包含指定 ID 的所有父节点
        function expandParentsOfItem(targetId) {
            console.log('Expanding parents for target:', targetId);
            console.log('Current expanded IDs before:', Array.from(expandedIds));
            
            function findAndExpandParents(tree, targetId, parentIds = []) {
                for (const node of tree) {
                    if (node.id === targetId) {
                        // 找到目标节点，展开所有父节点
                        console.log('Found target node, parent IDs:', parentIds);
                        parentIds.forEach(id => {
                            expandedIds.add(id);
                            console.log('Expanding parent:', id);
                        });
                        return true;
                    }
                    
                    if (node.children && node.children.length > 0) {
                        const found = findAndExpandParents(
                            node.children, 
                            targetId, 
                            [...parentIds, node.id]
                        );
                        if (found) return true;
                    }
                }
                return false;
            }
            
            const result = findAndExpandParents(treeData, targetId);
            console.log('Current expanded IDs after:', Array.from(expandedIds));
            return result;
        }

        function renderTree() {
            const traceList = document.getElementById('trace-list');
            const flatData = flattenTree(treeData);
            
            traceList.innerHTML = '';
            
            // 计算每个 trace 项所属的 blocks
            const traceToBlocks = computeTraceBlocks(flatData);
            
            flatData.forEach((item, index) => {
                const li = document.createElement('li');
                li.className = 'trace-item';
                li.dataset.id = item.id;
                
                // 应用 block 边框样式
                applyBlockBorders(li, item.id, traceToBlocks, flatData);
                applyPlaybackHighlight(li, item.id);
                
                // 应用层级深度缩进 - 动态计算
                if (item.depth !== undefined && item.depth > 0) {
                    li.dataset.depth = item.depth;
                    // 基础缩进 8px + 每层 12px
                    const indentPx = 8 + (item.depth * 12);
                    li.style.paddingLeft = \`\${indentPx}px\`;
                }
                
                // 计算 ID 背景色(根据 status)
                const status = item.status !== undefined ? item.status : 0;
                const bgColor = interpolateStatusColor(status);
                
                // 展开按钮:有子节点显示箭头,无子节点显示空白占位
                let expandClass = 'empty';
                if (item.hasChildren) {
                    expandClass = item.expanded ? 'expanded' : '';
                }
                
                li.innerHTML = \`
                    <span class="trace-expand \${expandClass}" data-id="\${item.id}"></span>
                    <span class="trace-id" style="background-color: \${bgColor};">#\${item.id}</span>
                    <div class="trace-info">
                        <span class="trace-method" title="\${item.method_name || 'N/A'}">\${item.method_name || 'N/A'}</span>
                        <span class="trace-line">:\${item.line}</span>
                    </div>
                \`;

                // 展开/折叠按钮点击事件
                const expandBtn = li.querySelector('.trace-expand');
                expandBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!item.hasChildren) return;
                    
                    // 切换展开状态
                    if (expandedIds.has(item.id)) {
                        expandedIds.delete(item.id);
                    } else {
                        expandedIds.add(item.id);
                    }
                    
                    // 重新渲染
                    renderTree();
                });

                // trace 项点击事件
                li.addEventListener('click', () => {
                    // 更新选中状态
                    document.querySelectorAll('.trace-item').forEach(el => {
                        el.classList.remove('selected');
                    });
                    li.classList.add('selected');
                    currentSelectedId = item.id;

                    // 更新数据流面板
                    updateDataflowPanel(item);

                    // 发送消息给扩展
                    vscode.postMessage({
                        command: 'navigateToLine',
                        src: item.src,
                        line: item.line
                    });
                });

                traceList.appendChild(li);
            });
        }

        // 计算每个 trace 所属的 blocks
        function computeTraceBlocks(flatData) {
            const traceToBlocks = {};
            
            flatData.forEach(item => {
                const traceId = item.id;
                const belongsToBlocks = [];
                
                blocksData.forEach(block => {
                    if (traceId >= block.startline && traceId <= block.endline) {
                        belongsToBlocks.push(block);
                    }
                });
                
                traceToBlocks[traceId] = belongsToBlocks;
            });
            
            return traceToBlocks;
        }

        // 应用 block 边框样式
        function applyBlockBorders(li, traceId, traceToBlocks, flatData) {
            const blocks = traceToBlocks[traceId] || [];
            
            if (blocks.length === 0) return;
            
            // 按照 block id 排序(保证一致性)
            blocks.sort((a, b) => a.id - b.id);
            
            // 使用第一个 block 的颜色(如果有多个 block 重叠,只显示第一个)
            const block = blocks[0];
            const colorClass = \`block-color-\${block.id % 8}\`;
            li.classList.add(colorClass);
            
            // 判断是否为 block 的起始行
            const isBlockStart = (traceId === block.startline);
            // 判断是否为 block 的结束行
            const isBlockEnd = (traceId === block.endline);
            
            // 左右边框始终显示
            li.classList.add('block-border-left');
            li.classList.add('block-border-right');
            
            // 上边框：仅在 block 起始行显示
            if (isBlockStart) {
                li.classList.add('block-border-top');
            }
            
            // 下边框：仅在 block 结束行显示
            if (isBlockEnd) {
                li.classList.add('block-border-bottom');
            }
        }

        function applyPlaybackHighlight(li, traceId) {
            if (!playbackRanges.length) {
                return;
            }

            for (const range of playbackRanges) {
                if (traceId < range.tstart || traceId > range.tend) {
                    continue;
                }

                li.classList.add('playback-active');
                li.classList.add('playback-color-' + range.colorIndex);
                return;
            }
        }

        // 根据 status (0-1) 插值计算 ID 背景色
        // status = 0: 默认 badge 背景色
        // status = 1: 红色(light/dark 主题自适应)
        function interpolateStatusColor(status) {
            // 确保 status 在 [0, 1] 范围内
            status = Math.max(0, Math.min(1, status));
            
            // 检测当前主题(light/dark)
            const isDark = document.body.classList.contains('vscode-dark') || 
                          document.body.classList.contains('vscode-high-contrast');
            
            // 默认背景色(从 CSS 变量获取,如果无法获取则使用预设值)
            const defaultColor = isDark ? { r: 60, g: 60, b: 60 } : { r: 230, g: 230, b: 230 };
            // 目标红色
            const targetColor = isDark ? { r: 200, g: 50, b: 50 } : { r: 220, g: 80, b: 80 };
            
            // 线性插值
            const r = Math.round(defaultColor.r + (targetColor.r - defaultColor.r) * status);
            const g = Math.round(defaultColor.g + (targetColor.g - defaultColor.g) * status);
            const b = Math.round(defaultColor.b + (targetColor.b - defaultColor.b) * status);
            
            return \`rgb(\${r}, \${g}, \${b})\`;
        }

        // 更新 Step Properties 面板
        function updateDataflowPanel(item) {
            const dataflowContainer = document.getElementById('dataflow-container');
            
            // 获取 read 和 written 数据
            const readData = item.read || [];
            const writtenData = item.written || [];
            
            // 构建 HTML
            let html = '<div class="step-properties-content">';
            
            // Toolbar 部分
            html += '<div class="properties-section">';
            html += '<div class="properties-toolbar">';
            html += '<div class="toolbar-left">';
            
            // Data 选项
            html += '<div class="toolbar-option" data-option="data">';
            html += '<div class="toolbar-radio" id="radio-data"></div>';
            html += '<span class="toolbar-label">data</span>';
            html += '</div>';
            
            // Control 选项
            html += '<div class="toolbar-option" data-option="control">';
            html += '<div class="toolbar-radio" id="radio-control"></div>';
            html += '<span class="toolbar-label">control</span>';
            html += '</div>';
            
            html += '</div>'; // toolbar-left
            
            // Go 按钮
            html += '<button class="toolbar-button" id="go-button">Go</button>';
            
            html += '</div>'; // properties-toolbar
            html += '</div>'; // properties-section
            
            // 分割线
            html += '<div class="properties-divider"></div>';
            
            // Read Variables 部分
            html += '<div class="properties-section">';
            html += '<div class="variables-section">';
            html += '<div class="variables-title">Read Variables</div>';
            html += renderVarTable(readData, 'read-vars');
            html += '</div>'; // variables-section
            html += '</div>'; // properties-section
            
            // 分割线
            html += '<div class="properties-divider"></div>';
            
            // Written Variables 部分
            html += '<div class="properties-section">';
            html += '<div class="variables-section">';
            html += '<div class="variables-title">Written Variables</div>';
            html += renderVarTable(writtenData, 'written-vars');
            html += '</div>'; // variables-section
            html += '</div>'; // properties-section
            
            html += '</div>'; // step-properties-content
            
            dataflowContainer.innerHTML = html;
            
            // 添加工具栏交互逻辑
            setupToolbarInteraction();
            
            // 添加变量树交互逻辑
            setupVarTreeInteraction();
        }
        
        // 设置变量树交互
        function setupVarTreeInteraction() {
            const expandBtns = document.querySelectorAll('.var-expand:not(.empty)');
            
            expandBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const varId = btn.getAttribute('data-var-id');
                    
                    // 切换展开状态
                    if (expandedVarIds.has(varId)) {
                        expandedVarIds.delete(varId);
                    } else {
                        expandedVarIds.add(varId);
                    }
                    
                    // 重新渲染当前选中的 trace item
                    // 从扁平化的 trace 数据中查找
                    const flatTraceData = flattenTree(treeData);
                    const selectedItem = flatTraceData.find(item => item.id === currentSelectedId);
                    if (selectedItem) {
                        updateDataflowPanel(selectedItem);
                    }
                });
            });
        }
        
        // HTML 转义函数
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // 用于存储变量树的展开状态
        let expandedVarIds = new Set();
        
        // 构建变量树形结构
        function buildVarTree(flatData) {
            if (!flatData || flatData.length === 0) return [];
            
            const result = [];
            const stack = [];
            
            flatData.forEach((item, index) => {
                const depth = item.depth !== undefined ? item.depth : 0;
                
                const node = {
                    ...item,
                    depth: depth,
                    children: [],
                    index: index,
                    uniqueId: \`var_\${index}_\${item.name}\`
                };
                
                if (depth === 0) {
                    result.push(node);
                    stack.length = 1;
                    stack[0] = node;
                } else {
                    while (stack.length > depth) {
                        stack.pop();
                    }
                    
                    if (stack.length > 0 && depth > 0) {
                        const parent = stack[stack.length - 1];
                        parent.children.push(node);
                        stack[depth] = node;
                    } else {
                        result.push(node);
                        stack[0] = node;
                    }
                }
            });
            
            return result;
        }
        
        // 扁平化变量树
        function flattenVarTree(tree, parentExpanded = true, parentDepth = -1) {
            const result = [];
            
            tree.forEach(node => {
                const shouldShow = parentDepth === -1 || parentExpanded;
                
                if (shouldShow) {
                    const isExpanded = expandedVarIds.has(node.uniqueId);
                    const hasChildren = node.children && node.children.length > 0;
                    
                    result.push({
                        ...node,
                        hasChildren: hasChildren,
                        expanded: isExpanded
                    });
                    
                    if (hasChildren) {
                        const childrenFlat = flattenVarTree(node.children, isExpanded, node.depth);
                        result.push(...childrenFlat);
                    }
                }
            });
            
            return result;
        }
        
        // 渲染变量表格
        function renderVarTable(data, containerId) {
            if (!data || data.length === 0) {
                return '<div class="variables-empty">No variables</div>';
            }
            
            const tree = buildVarTree(data);
            const flatData = flattenVarTree(tree);
            
            let html = '<div class="variables-table-wrapper">';
            html += '<table class="variables-table">';
            html += '<thead><tr>';
            html += '<th>Type</th>';
            html += '<th>Name</th>';
            html += '<th>Value</th>';
            html += '<th>ID</th>';
            html += '</tr></thead>';
            html += '<tbody>';
            
            flatData.forEach(record => {
                html += \`<tr class="var-row" data-var-id="\${record.uniqueId}" data-depth="\${record.depth}">\`;
                
                // Type 列（包含缩进和展开按钮）
                html += '<td>';
                html += '<div class="var-name-cell">';
                
                // 添加缩进
                if (record.depth > 0) {
                    const indentWidth = record.depth * 8;
                    html += \`<span style="width: \${indentWidth}px; flex-shrink: 0;"></span>\`;
                }
                
                // 展开/折叠按钮
                let expandClass = record.hasChildren ? (record.expanded ? 'expanded' : '') : 'empty';
                html += \`<span class="var-expand \${expandClass}" data-var-id="\${record.uniqueId}"></span>\`;
                
                // 类型名
                html += \`<span class="var-name-text">\${escapeHtml(record.type || '')}</span>\`;
                
                html += '</div>';
                html += '</td>';
                
                // Name 列
                html += \`<td>\${escapeHtml(record.name || '')}</td>\`;
                
                // Value 列
                const valueStr = typeof record.value === 'object' ? 
                    JSON.stringify(record.value) : 
                    (record.value !== undefined && record.value !== null ? String(record.value) : '');
                html += \`<td>\${escapeHtml(valueStr)}</td>\`;
                
                // ID 列
                html += \`<td>\${escapeHtml(record.id || '')}</td>\`;
                
                html += '</tr>';
            });
            
            html += '</tbody>';
            html += '</table>';
            html += '</div>';
            
            return html;
        }
        
        // HTML 转义函数
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = String(text);
            return div.innerHTML;
        }
        
        // 设置工具栏交互
        let selectedOption = null; // 'data', 'control', or null
        
        function setupToolbarInteraction() {
            const dataOption = document.querySelector('[data-option="data"]');
            const controlOption = document.querySelector('[data-option="control"]');
            const dataRadio = document.getElementById('radio-data');
            const controlRadio = document.getElementById('radio-control');
            const goButton = document.getElementById('go-button');
            
            // Data 选项点击
            dataOption?.addEventListener('click', () => {
                if (selectedOption === 'data') {
                    // 取消选择
                    selectedOption = null;
                    dataRadio.classList.remove('selected');
                } else {
                    // 选择 data，取消 control
                    selectedOption = 'data';
                    dataRadio.classList.add('selected');
                    controlRadio.classList.remove('selected');
                }
            });
            
            // Control 选项点击
            controlOption?.addEventListener('click', () => {
                if (selectedOption === 'control') {
                    // 取消选择
                    selectedOption = null;
                    controlRadio.classList.remove('selected');
                } else {
                    // 选择 control，取消 data
                    selectedOption = 'control';
                    controlRadio.classList.add('selected');
                    dataRadio.classList.remove('selected');
                }
            });
            
            // Go 按钮点击
            goButton?.addEventListener('click', () => {
                console.log('Go button clicked, selected option:', selectedOption);
                // TODO: 实现 Go 按钮的功能
                vscode.postMessage({
                    command: 'goButtonClicked',
                    option: selectedOption
                });
            });
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        this.clearPlaybackHighlight();
        this.decorationType.dispose();
        for (const set of this.playbackDecorationTypes) {
            set.single.dispose();
            set.top.dispose();
            set.middle.dispose();
            set.bottom.dispose();
        }
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }
}
