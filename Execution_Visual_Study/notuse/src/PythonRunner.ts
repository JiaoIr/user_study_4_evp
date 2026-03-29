import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { resolvePythonPath } from './PythonEnv';

let outputChannel: vscode.OutputChannel;

interface InstrumentationArgs {
    segmentCount: number;
    segmentPoints?: number[];
}

interface PipelinePaths {
    workspaceRoot: string;
    instJsonPath: string;
    animeJsonPath: string;
    frameJsonPath: string;
    designWorkDir: string;
    instMainPath: string;
    step12Path: string;
    step3Path: string;
}

interface PipelineSettings {
    model: string;
    maxRefineRounds: number;
}

interface VisualizeFormData {
    entryPoint: string;
    testCaseStartLine: number | null;
    testCaseEndLine: number | null;
    model: string;
    maxRefineRounds: number;
    animeJsonPath: string;
    visualFunction: string;
    testDescription: string;
    testFailure: string;
}

const DEBUG_PROMPT_TOKEN = 'Press Enter to load response.txt';

function isDebugPromptText(text: string): boolean {
    if (text.includes(DEBUG_PROMPT_TOKEN)) {
        return true;
    }

    // Fallback for Windows encoding mojibake: keep ASCII anchors.
    const lower = text.toLowerCase();
    return lower.includes('response.txt') && lower.includes('enter');
}

export async function runPythonInstrumentation(context: vscode.ExtensionContext) {
    const completed = await runPythonInstrumentationWithArgs(context, { segmentCount: 0 });
    if (completed) {
        vscode.window.showInformationMessage('Trace generation completed successfully.');
    }
}

export async function runSuspiciousVisualizationPipeline(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const channel = ensureOutputChannel();
    channel.show();

    const paths = buildPipelinePaths(context, workspaceRoot);

    let latestRunDir = getLatestRunDir(paths.designWorkDir) ?? '';
    const initialData = buildInitialVisualizeFormData(paths);

    const panel = vscode.window.createWebviewPanel(
        'visualPilotSuspiciousWorkflow',
        'VisualPilot Suspicious Visualization',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getVisualizeWorkflowWebviewHtml(initialData);

    panel.webview.onDidReceiveMessage(async (message: { command?: string; data?: VisualizeFormData }) => {
        const formData = message.data;
        if (!message.command || !formData) {
            return;
        }

        try {
            const settings = getPipelineSettingsFromForm(formData);
            const animeJsonPath = formData.animeJsonPath?.trim() || paths.animeJsonPath;

            switch (message.command) {
                case 'saveInst': {
                    const saved = saveInstConfig(paths.instJsonPath, paths.workspaceRoot, formData);
                    channel.appendLine(`Saved inst.json: ${saved}`);
                    panel.webview.postMessage({ command: 'status', text: `已保存 inst.json: ${saved}` });
                    vscode.window.showInformationMessage('inst.json 已保存');
                    break;
                }
                case 'runStep0': {
                    saveInstConfig(paths.instJsonPath, paths.workspaceRoot, formData);
                    const ok = await runStep0(paths, channel);
                    if (!ok) {
                        throw new Error('Step 0 failed.');
                    }
                    panel.webview.postMessage({ command: 'status', text: 'Step 0 执行完成。' });
                    break;
                }
                case 'runStep1': {
                    if (!validatePythonInstConfig(paths.instJsonPath)) {
                        return;
                    }
                    saveAnimeConfig(animeJsonPath, formData);
                    const runDir = await runStep1(paths, channel, settings, animeJsonPath);
                    latestRunDir = runDir;
                    panel.webview.postMessage({ command: 'status', text: `Step 1 完成。run_dir: ${runDir}` });
                    break;
                }
                case 'runStep2': {
                    const runDir = resolveActiveRunDir(paths.designWorkDir, latestRunDir);
                    if (!runDir) {
                        throw new Error('请先执行 Step 1 以生成 run_dir。');
                    }
                    const ok = await runStep2(paths, channel, runDir);
                    if (!ok) {
                        throw new Error('Step 2 failed.');
                    }
                    latestRunDir = runDir;
                    panel.webview.postMessage({ command: 'status', text: 'Step 2 执行完成。' });
                    break;
                }
                case 'runStep3': {
                    const runDir = resolveActiveRunDir(paths.designWorkDir, latestRunDir);
                    if (!runDir) {
                        throw new Error('请先执行 Step 1 以生成 run_dir。');
                    }
                    const ok = await runStep3(paths, channel, settings, animeJsonPath, runDir);
                    if (!ok) {
                        throw new Error('Step 3 failed.');
                    }
                    latestRunDir = runDir;
                    panel.webview.postMessage({ command: 'status', text: `流程完成。结果目录: ${runDir}` });
                    vscode.window.showInformationMessage(`可疑测试可视化已完成。结果目录: ${runDir}`);
                    break;
                }
                case 'runStep4': {
                    const runDir = resolveActiveRunDir(paths.designWorkDir, latestRunDir);
                    if (!runDir) {
                        throw new Error('请先执行 Step 1 以生成 run_dir。');
                    }
                    const ok = await runStep4(channel, runDir);
                    if (!ok) {
                        throw new Error('Step 4 failed.');
                    }
                    latestRunDir = runDir;
                    panel.webview.postMessage({ command: 'status', text: `Step 4 完成。视频已生成。` });
                    panel.dispose();
                    await vscode.commands.executeCommand('visualPilot.playSlides');
                    break;
                }
                case 'runAll': {
                    saveInstConfig(paths.instJsonPath, paths.workspaceRoot, formData);
                    saveAnimeConfig(animeJsonPath, formData);
                    const ok0 = await runStep0(paths, channel);
                    if (!ok0) {
                        throw new Error('Step 0 failed.');
                    }

                    const runDir = await runStep1(paths, channel, settings, animeJsonPath);
                    latestRunDir = runDir;

                    const ok2 = await runStep2(paths, channel, runDir);
                    if (!ok2) {
                        throw new Error('Step 2 failed.');
                    }

                    const ok3 = await runStep3(paths, channel, settings, animeJsonPath, runDir);
                    if (!ok3) {
                        throw new Error('Step 3 failed.');
                    }

                    const ok4 = await runStep4(channel, runDir);
                    if (!ok4) {
                        throw new Error('Step 4 failed.');
                    }

                    panel.webview.postMessage({ command: 'status', text: `流程完成。结果目录: ${runDir}` });
                    panel.dispose();
                    await vscode.commands.executeCommand('visualPilot.playSlides');
                    vscode.window.showInformationMessage(`可疑测试可视化已完成。结果目录: ${runDir}`);
                    break;
                }
            }
        } catch (error) {
            const messageText = String(error);
            channel.appendLine(`Pipeline action failed: ${messageText}`);
            panel.webview.postMessage({ command: 'status', text: `失败: ${messageText}` });
            vscode.window.showErrorMessage(`可疑测试可视化失败: ${messageText}`);
        }
    });
}

async function runPythonInstrumentationWithArgs(context: vscode.ExtensionContext, args: InstrumentationArgs): Promise<boolean> {
    const channel = ensureOutputChannel();
    channel.show();
    channel.appendLine('Starting Python instrumentation...');

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return false;
    }

    const instJsonPath = path.join(workspaceRoot, '__debug', 'trace', 'inst.json');
    if (!validatePythonInstConfig(instJsonPath)) {
        return false;
    }

    const pythonPath = await resolvePythonPath(channel);
    const scriptPath = path.join(context.extensionUri.fsPath, 'python_inst', 'main.py');

    channel.appendLine(`Python Interpreter: ${pythonPath}`);
    channel.appendLine(`Script Agent: ${scriptPath}`);
    channel.appendLine(`Config: ${instJsonPath}`);

    const ok = await runInstrumentationStep({
        pythonPath,
        workspaceRoot,
        instJsonPath,
        scriptPath,
        segmentCount: args.segmentCount,
        segmentPoints: args.segmentPoints,
        outputChannel: channel
    });

    if (!ok) {
        vscode.window.showErrorMessage('Trace generation failed. Check output for details.');
        return false;
    }

    return true;
}

function ensureOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('VisualPilot Python Trace');
    }
    return outputChannel;
}

function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
}

function validatePythonInstConfig(instJsonPath: string): boolean {
    if (!fs.existsSync(instJsonPath)) {
        vscode.window.showErrorMessage('Configuration file not found. Please run "VisualPilot: Init Python Trace" first.');
        return false;
    }

    try {
        const config = JSON.parse(fs.readFileSync(instJsonPath, 'utf-8'));
        if (config.language !== 'python') {
            vscode.window.showErrorMessage('Current configuration is not for Python. Please re-initialize trace.');
            return false;
        }
    } catch {
        vscode.window.showErrorMessage('Invalid configuration file.');
        return false;
    }

    return true;
}

function buildPipelinePaths(context: vscode.ExtensionContext, workspaceRoot: string) {
    const designWorkDir = path.join(workspaceRoot, '__debug', 'anime', 'design');
    fs.mkdirSync(designWorkDir, { recursive: true });
    return {
        workspaceRoot,
        instJsonPath: path.join(workspaceRoot, '__debug', 'trace', 'inst.json'),
        animeJsonPath: path.join(workspaceRoot, '__debug', 'anime', 'anime.json'),
        frameJsonPath: path.join(workspaceRoot, '__debug', 'trace', 'frame.json'),
        designWorkDir,
        instMainPath: path.join(context.extensionUri.fsPath, 'python_inst', 'main.py'),
        step12Path: path.join(context.extensionUri.fsPath, 'design', 'design_engine_step12.py'),
        step3Path: path.join(context.extensionUri.fsPath, 'design', 'design_engine_step3.py')
    };
}

function buildInitialVisualizeFormData(paths: PipelinePaths): VisualizeFormData {
    const defaults = {
        entry_point: 'test/test_scale.py',
        test_case_start_line: null,
        test_case_end_line: null
    } as { entry_point?: string; test_case_start_line?: number | null; test_case_end_line?: number | null };

    if (fs.existsSync(paths.instJsonPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(paths.instJsonPath, 'utf-8')) as Record<string, unknown>;
            defaults.entry_point = String(existing.entry_point ?? defaults.entry_point);
            defaults.test_case_start_line = toNullableInt(existing.test_case_start_line);
            defaults.test_case_end_line = toNullableInt(existing.test_case_end_line);
        } catch {
            // keep defaults
        }
    }

    const animeDefaults = readAnimeDefaults(paths.animeJsonPath);

    return {
        entryPoint: defaults.entry_point ?? 'test/test_scale.py',
        testCaseStartLine: defaults.test_case_start_line ?? null,
        testCaseEndLine: defaults.test_case_end_line ?? null,
        model: 'debug',
        maxRefineRounds: 2,
        animeJsonPath: paths.animeJsonPath,
        visualFunction: animeDefaults.visualFunction,
        testDescription: animeDefaults.testDescription,
        testFailure: animeDefaults.testFailure
    };
}

function readAnimeDefaults(animeJsonPath: string): { visualFunction: string; testDescription: string; testFailure: string } {
    if (!fs.existsSync(animeJsonPath)) {
        return {
            visualFunction: '',
            testDescription: '',
            testFailure: ''
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(animeJsonPath, 'utf-8')) as Record<string, unknown>;
        return {
            visualFunction: String(parsed.visual_function ?? ''),
            testDescription: String(parsed.test_description ?? ''),
            testFailure: String(parsed.test_failure ?? '')
        };
    } catch {
        return {
            visualFunction: '',
            testDescription: '',
            testFailure: ''
        };
    }
}

function toNullableInt(value: unknown): number | null {
    const n = Number(value);
    if (!Number.isInteger(n)) {
        return null;
    }
    return n;
}

function getPipelineSettingsFromForm(data: VisualizeFormData): PipelineSettings {
    const model = String(data.model || '').trim() || 'gpt-5-mini';
    const maxRefineRounds = Number(data.maxRefineRounds);
    if (!Number.isInteger(maxRefineRounds) || maxRefineRounds < 0) {
        throw new Error('max-refine-rounds 必须是大于等于 0 的整数。');
    }
    return { model, maxRefineRounds };
}

function saveInstConfig(instJsonPath: string, workspaceRoot: string, data: VisualizeFormData): string {
    const entryPoint = String(data.entryPoint || '').trim();
    if (!entryPoint) {
        throw new Error('entry_point 不能为空。');
    }

    const config = {
        language: 'python',
        entry_point: entryPoint,
        filters: {
            include: ['src'],
            exclude: ['tests', 'venv', '.git', '.idea', '__pycache__']
        },
        workspace_root: workspaceRoot,
        test_case_start_line: data.testCaseStartLine,
        test_case_end_line: data.testCaseEndLine
    } as Record<string, unknown>;

    if (data.testCaseStartLine === null) {
        delete config.test_case_start_line;
    }
    if (data.testCaseEndLine === null) {
        delete config.test_case_end_line;
    }

    fs.mkdirSync(path.dirname(instJsonPath), { recursive: true });
    fs.writeFileSync(instJsonPath, JSON.stringify(config, null, 4), 'utf-8');
    return instJsonPath;
}

function saveAnimeConfig(animeJsonPath: string, data: VisualizeFormData): string {
    const visualFunction = String(data.visualFunction || '').trim();
    const testDescription = String(data.testDescription || '').trim();
    const testFailure = String(data.testFailure || '').trim();

    if (!visualFunction) {
        throw new Error('visual_function 不能为空。');
    }
    if (!testDescription) {
        throw new Error('test_description 不能为空。');
    }
    if (!testFailure) {
        throw new Error('test_failure 不能为空。');
    }

    const parsed = {
        visual_function: visualFunction,
        test_description: testDescription,
        test_failure: testFailure,
        trace: '__debug/trace/trace.json',
        code: '__debug/trace/code.json',
        frame: '__debug/trace/frame.json'
    };

    fs.mkdirSync(path.dirname(animeJsonPath), { recursive: true });
    fs.writeFileSync(animeJsonPath, JSON.stringify(parsed, null, 4), 'utf-8');
    return animeJsonPath;
}

async function runStep0(paths: PipelinePaths, channel: vscode.OutputChannel): Promise<boolean> {
    const pythonPath = await resolvePythonPath(channel);
    channel.appendLine('\n[Step 0] Running initial instrumentation...');
    return runInstrumentationStep({
        pythonPath,
        workspaceRoot: paths.workspaceRoot,
        instJsonPath: paths.instJsonPath,
        scriptPath: paths.instMainPath,
        segmentCount: 0,
        outputChannel: channel
    });
}

async function runStep1(
    paths: PipelinePaths,
    channel: vscode.OutputChannel,
    settings: PipelineSettings,
    animeJsonPath: string
): Promise<string> {
    const pythonPath = await resolvePythonPath(channel);
    const targetAnime = animeJsonPath || paths.animeJsonPath;

    channel.appendLine('\n[Step 1] Running design_engine_step12.py ...');
    const ok = await runPythonProcess({
        pythonPath,
        scriptPath: paths.step12Path,
        args: [
            '--model', settings.model,
            '--max-refine-rounds', String(settings.maxRefineRounds),
            '--anime-json', targetAnime,
            '--work-dir', paths.designWorkDir
        ],
        cwd: paths.workspaceRoot,
        outputChannel: channel,
        debugSession: settings.model === 'debug' ? { workDir: paths.designWorkDir, title: 'Step1-2 Debug Session' } : undefined
    });
    if (!ok) {
        throw new Error('Step1-2 failed.');
    }

    const runDir = getLatestRunDir(paths.designWorkDir);
    if (!runDir) {
        throw new Error(`Cannot resolve latest run dir from ${paths.designWorkDir}`);
    }
    channel.appendLine(`[Step 1] Latest run dir: ${runDir}`);
    return runDir;
}

async function runStep2(paths: PipelinePaths, channel: vscode.OutputChannel, runDir: string): Promise<boolean> {
    const pythonPath = await resolvePythonPath(channel);
    channel.appendLine('\n[Step 2] Running second instrumentation from blocks_entire.json ...');
    const blockArg = buildBlockSegmentArgs(path.join(runDir, 'state', 'blocks_entire.json'));
    return runInstrumentationStep({
        pythonPath,
        workspaceRoot: paths.workspaceRoot,
        instJsonPath: paths.instJsonPath,
        scriptPath: paths.instMainPath,
        segmentCount: blockArg.segmentCount,
        segmentPoints: blockArg.segmentPoints,
        outputChannel: channel
    });
}

async function runStep3(
    paths: PipelinePaths,
    channel: vscode.OutputChannel,
    settings: PipelineSettings,
    animeJsonPath: string,
    runDir: string
): Promise<boolean> {
    const pythonPath = await resolvePythonPath(channel);
    const targetAnime = animeJsonPath || paths.animeJsonPath;

    channel.appendLine('\n[Step 3] Running design_engine_step3.py ...');
    return runPythonProcess({
        pythonPath,
        scriptPath: paths.step3Path,
        args: [
            '--model', settings.model,
            '--max-refine-rounds', String(settings.maxRefineRounds),
            '--anime-json', targetAnime,
            '--frame-json', paths.frameJsonPath,
            '--run-dir', runDir,
            '--work-dir', paths.designWorkDir
        ],
        cwd: paths.workspaceRoot,
        outputChannel: channel,
        debugSession: settings.model === 'debug' ? { workDir: paths.designWorkDir, title: 'Step3 Debug Session' } : undefined
    });
}

async function runStep4(channel: vscode.OutputChannel, runDir: string): Promise<boolean> {
    const pythonPath = await resolvePythonPath(channel);
    const resultDir = path.join(runDir, 'result');
    if (!fs.existsSync(resultDir)) {
        throw new Error(`result directory not found: ${resultDir}`);
    }

    const generateScriptPath = path.join(resultDir, 'generate_script.py');
    const generatedScriptPath = path.join(resultDir, 'generated_script.py');

    // Ensure exact command target exists in the strict result directory.
    if (!fs.existsSync(generateScriptPath) && fs.existsSync(generatedScriptPath)) {
        fs.copyFileSync(generatedScriptPath, generateScriptPath);
    }

    if (!fs.existsSync(generateScriptPath)) {
        throw new Error(`generate_script.py not found in ${resultDir}`);
    }

    channel.appendLine('\n[Step 4] Running manim render with configured conda python...');
    channel.appendLine(`[Step 4] Python: ${pythonPath}`);
    channel.appendLine(`[Step 4] CWD: ${resultDir}`);
    channel.appendLine('[Step 4] Command: python -m manim_slides render generate_script.py VisualPilotScene');

    const ok = await runCommandProcess({
        command: pythonPath,
        args: ['-m', 'manim_slides', 'render', 'generate_script.py', 'VisualPilotScene'],
        cwd: resultDir,
        outputChannel: channel
    });

    if (!ok) {
        return false;
    }

    const videoPath = findGeneratedVideoPath(resultDir);
    if (!videoPath) {
        throw new Error(`Step 4 finished but VisualPilotScene.mp4 was not found under ${resultDir}`);
    }

    channel.appendLine(`[Step 4] Video generated: ${videoPath}`);
    return true;
}

function findGeneratedVideoPath(resultDir: string): string | undefined {
    const expected = path.join(resultDir, 'media', 'videos', 'generate_script', '1920p60', 'VisualPilotScene.mp4');
    if (fs.existsSync(expected)) {
        return expected;
    }

    const stack: string[] = [resultDir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }

            if (entry.isFile() && entry.name === 'VisualPilotScene.mp4') {
                return full;
            }
        }
    }

    return undefined;
}

function resolveActiveRunDir(designWorkDir: string, latestRunDir: string): string {
    if (latestRunDir && fs.existsSync(latestRunDir)) {
        return latestRunDir;
    }
    const fromLatestFile = getLatestRunDir(designWorkDir);
    if (fromLatestFile && fs.existsSync(fromLatestFile)) {
        return fromLatestFile;
    }
    return '';
}

function getVisualizeWorkflowWebviewHtml(initialData: VisualizeFormData): string {
    const initialDataJson = JSON.stringify(initialData)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/<\\\/script/gi, '<\\\\/script');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VisualPilot Suspicious Workflow</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
        .card { border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 12px; margin-bottom: 14px; }
        .row { display: grid; grid-template-columns: 180px 1fr; gap: 10px; align-items: center; margin-bottom: 8px; }
        .row label { font-weight: 600; }
        input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
        textarea { width: 100%; min-height: 220px; box-sizing: border-box; padding: 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: Consolas, monospace; }
        .btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
        button { padding: 6px 10px; border: none; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .status { margin-top: 10px; padding: 8px; border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); min-height: 20px; white-space: pre-wrap; }
        .hint { opacity: 0.85; margin: 4px 0 0; }
    </style>
</head>
<body>
    <h2>可疑测试可视化工作流</h2>

    <div class="card">
        <h3>1) inst.json 配置与插桩</h3>
        <div class="row"><label>entry_point</label><input id="entryPoint" placeholder="test/test_scale.py"></div>
        <div class="row"><label>test_case_start_line</label><input id="testCaseStart" placeholder="例如 27，可空"></div>
        <div class="row"><label>test_case_end_line</label><input id="testCaseEnd" placeholder="例如 27，可空"></div>
        <p class="hint">保存后会写入 __debug/trace/inst.json。可先点“保存 inst.json”，再点“执行 Step 0”。</p>
        <div class="btns">
            <button class="secondary" id="saveInst">保存 inst.json</button>
            <button id="runStep0">执行 Step 0 (插桩)</button>
        </div>
    </div>

    <div class="card">
        <h3>2) Design Engine 步骤控制</h3>
        <div class="row"><label>model</label><input id="model" placeholder="gpt-5-mini"></div>
        <div class="row"><label>max_refine_rounds</label><input id="maxRefineRounds" placeholder="2"></div>
        <div class="row"><label>anime_json</label><input id="animeJsonPath" placeholder="__debug/anime/anime.json"></div>
        <div class="row"><label>visual_function</label><input id="visualFunction" placeholder="src.chart.chart.scale#15"></div>
        <div class="row"><label>test_description</label><input id="testDescription" placeholder="Describe test case"></div>
        <div class="row"><label>test_failure</label><textarea id="testFailure" spellcheck="false" style="min-height: 120px;"></textarea></div>
        <p class="hint">Step 1 会按输入自动生成 anime.json；trace/code/frame 路径固定使用默认值。</p>
        <div class="btns">
            <button id="runStep1">执行 Step 1</button>
            <button id="runStep2">执行 Step 2</button>
            <button id="runStep3">执行 Step 3</button>
            <button id="runStep4">执行 Step 4</button>
            <button class="secondary" id="runAll">一键执行 0→1→2→3→4</button>
        </div>
    </div>

    <div class="status" id="status"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const initialData = ${initialDataJson};

        const byId = (id) => document.getElementById(id);

        byId('entryPoint').value = initialData.entryPoint || '';
        byId('testCaseStart').value = initialData.testCaseStartLine ?? '';
        byId('testCaseEnd').value = initialData.testCaseEndLine ?? '';
        byId('model').value = initialData.model || 'gpt-5-mini';
        byId('maxRefineRounds').value = initialData.maxRefineRounds ?? 2;
        byId('animeJsonPath').value = initialData.animeJsonPath || '';
        byId('visualFunction').value = initialData.visualFunction || '';
        byId('testDescription').value = initialData.testDescription || '';
        byId('testFailure').value = initialData.testFailure || '';

        function parseNullableInt(text) {
            const v = String(text || '').trim();
            if (!v) return null;
            const n = Number(v);
            if (!Number.isInteger(n)) return null;
            return n;
        }

        function collectData() {
            return {
                entryPoint: byId('entryPoint').value,
                testCaseStartLine: parseNullableInt(byId('testCaseStart').value),
                testCaseEndLine: parseNullableInt(byId('testCaseEnd').value),
                model: byId('model').value,
                maxRefineRounds: Number(byId('maxRefineRounds').value),
                animeJsonPath: byId('animeJsonPath').value,
                visualFunction: byId('visualFunction').value,
                testDescription: byId('testDescription').value,
                testFailure: byId('testFailure').value,
            };
        }

        function post(command) {
            vscode.postMessage({ command, data: collectData() });
            byId('status').textContent = '执行中: ' + command + ' ...';
        }

        byId('saveInst').addEventListener('click', () => post('saveInst'));
        byId('runStep0').addEventListener('click', () => post('runStep0'));
        byId('runStep1').addEventListener('click', () => post('runStep1'));
        byId('runStep2').addEventListener('click', () => post('runStep2'));
        byId('runStep3').addEventListener('click', () => post('runStep3'));
        byId('runStep4').addEventListener('click', () => post('runStep4'));
        byId('runAll').addEventListener('click', () => post('runAll'));

        window.addEventListener('message', (event) => {
            const msg = event.data || {};
            if (msg.command === 'status') {
                byId('status').textContent = msg.text || '';
            }
        });
    </script>
</body>
</html>`;
}

function getLatestRunDir(designWorkDir: string): string | undefined {
    const latestPath = path.join(designWorkDir, 'latest_run.txt');
    if (!fs.existsSync(latestPath)) {
        return undefined;
    }
    const runDir = fs.readFileSync(latestPath, 'utf-8').trim();
    if (!runDir || !fs.existsSync(runDir)) {
        return undefined;
    }
    return runDir;
}

function buildBlockSegmentArgs(blocksEntirePath: string): { segmentCount: number; segmentPoints: number[] } {
    if (!fs.existsSync(blocksEntirePath)) {
        throw new Error(`blocks_entire.json not found: ${blocksEntirePath}`);
    }

    const parsed = JSON.parse(fs.readFileSync(blocksEntirePath, 'utf-8')) as { blocks?: Array<{ tstart?: number; tend?: number }> };
    const blocks = parsed.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) {
        throw new Error('blocks_entire.json does not contain valid blocks.');
    }

    const firstStart = Number(blocks[0]?.tstart);
    if (!Number.isInteger(firstStart) || firstStart <= 0) {
        throw new Error('Invalid tstart in first block.');
    }

    const tends = blocks.map((item, idx) => {
        const value = Number(item?.tend);
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`Invalid tend in block index ${idx}.`);
        }
        return value;
    });

    const points = [firstStart, ...tends];
    const segmentCount = blocks.length + 1;
    return { segmentCount, segmentPoints: points };
}

async function runInstrumentationStep(input: {
    pythonPath: string;
    workspaceRoot: string;
    instJsonPath: string;
    scriptPath: string;
    segmentCount: number;
    segmentPoints?: number[];
    outputChannel: vscode.OutputChannel;
}): Promise<boolean> {
    const args = [
        '--config', input.instJsonPath,
        String(input.segmentCount)
    ];

    if (input.segmentPoints && input.segmentPoints.length > 0) {
        args.push(`[${input.segmentPoints.join(', ')}]`);
    }

    return runPythonProcess({
        pythonPath: input.pythonPath,
        scriptPath: input.scriptPath,
        args,
        cwd: input.workspaceRoot,
        outputChannel: input.outputChannel
    });
}

async function runPythonProcess(input: {
    pythonPath: string;
    scriptPath: string;
    args: string[];
    cwd: string;
    outputChannel: vscode.OutputChannel;
    debugSession?: { workDir: string; title: string };
}): Promise<boolean> {
    input.outputChannel.appendLine(`Running: ${input.pythonPath} ${[input.scriptPath, ...input.args].join(' ')}`);

    return new Promise<boolean>((resolve) => {
        const proc = spawn(input.pythonPath, [input.scriptPath, ...input.args], {
            cwd: input.cwd,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let settled = false;
        let handlingDebugPrompt = false;

        const settle = (ok: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(ok);
        };

        const tryHandleDebugPrompt = async () => {
            if (!input.debugSession || handlingDebugPrompt || settled) {
                return;
            }
            handlingDebugPrompt = true;

            try {
                const accepted = await handleDebugInteraction(input.debugSession.title, input.debugSession.workDir);
                if (!accepted) {
                    proc.kill();
                    settle(false);
                    return;
                }
                proc.stdin.write('\n');
            } catch (error) {
                input.outputChannel.appendLine(`Debug interaction failed: ${String(error)}`);
                proc.kill();
                settle(false);
                return;
            } finally {
                handlingDebugPrompt = false;
            }
        };

        proc.stdout.on('data', (data) => {
            const text = data.toString();
            input.outputChannel.append(text);
            if (input.debugSession && isDebugPromptText(text)) {
                void tryHandleDebugPrompt();
            }
        });

        proc.stderr.on('data', (data) => {
            input.outputChannel.append(data.toString());
        });

        proc.on('error', (err) => {
            input.outputChannel.appendLine(`Process error: ${String(err)}`);
            settle(false);
        });

        proc.on('close', (code) => {
            input.outputChannel.appendLine(`Process finished with code ${code}`);
            settle(code === 0);
        });
    });
}

async function runCommandProcess(input: {
    command: string;
    args: string[];
    cwd: string;
    outputChannel: vscode.OutputChannel;
}): Promise<boolean> {
    input.outputChannel.appendLine(`Running: ${input.command} ${input.args.join(' ')}`);

    return new Promise<boolean>((resolve) => {
        const proc = spawn(input.command, input.args, {
            cwd: input.cwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let settled = false;
        const settle = (ok: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(ok);
        };

        proc.stdout.on('data', (data) => {
            input.outputChannel.append(data.toString());
        });

        proc.stderr.on('data', (data) => {
            input.outputChannel.append(data.toString());
        });

        proc.on('error', (err) => {
            input.outputChannel.appendLine(`Process error: ${String(err)}`);
            settle(false);
        });

        proc.on('close', (code) => {
            input.outputChannel.appendLine(`Process finished with code ${code}`);
            settle(code === 0);
        });
    });
}

async function handleDebugInteraction(title: string, workDir: string): Promise<boolean> {
    const queryPath = path.join(workDir, 'query.txt');
    const responsePath = path.join(workDir, 'response.txt');

    if (!fs.existsSync(responsePath)) {
        fs.writeFileSync(responsePath, '', 'utf-8');
    }

    // Reset response so continuation requires fresh user input for this round.
    fs.writeFileSync(responsePath, '', 'utf-8');

    await openTextFileIfExists(queryPath);
    await openTextFileIfExists(responsePath);

    vscode.window.showInformationMessage(
        `${title}: Edit response.txt and save. The pipeline will continue automatically once response.txt is non-empty.`
    );

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `${title}: Waiting for response.txt...`,
            cancellable: true
        },
        async (progress, token) => {
            progress.report({ message: 'Open query.txt, write your answer in response.txt, then save.' });

            while (!token.isCancellationRequested) {
                try {
                    const content = fs.readFileSync(responsePath, 'utf-8').trim();
                    if (content) {
                        return true;
                    }
                } catch {
                    // Keep waiting when file is being edited concurrently.
                }
                await sleep(500);
            }
            return false;
        }
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openTextFileIfExists(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
        return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
}
