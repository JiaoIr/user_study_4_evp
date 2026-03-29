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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const TraceViewProvider_1 = require("./TraceViewProvider");
const SlidesOverlayController_1 = require("./SlidesOverlayController");
const LlmGenerationController_1 = require("./LlmGenerationController");
const PythonTutorController_1 = require("./PythonTutorController");
let currentId;
function toTimestampForFile(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}
function toIsoTime(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const mss = String(d.getMilliseconds()).padStart(3, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${mss}`;
}
function sanitizeForFileName(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
function getExplainCommandByType(explainType) {
    if (explainType === 'Explain by pythonTutor') {
        return 'Execution_Visual_Study.explainByPythonTutor';
    }
    if (explainType === 'Explain by llmGeneration') {
        return 'Execution_Visual_Study.explainByLlmGeneration';
    }
    return 'Execution_Visual_Study.explainByVisualPilot';
}
function toGroupLabel(explainType) {
    const raw = String(explainType || '').trim();
    if (raw === 'Explain by visualPilot') {
        return 'G1';
    }
    if (raw === 'Explain by pythonTutor') {
        return 'G2';
    }
    if (raw === 'Explain by llmGeneration') {
        return 'G3';
    }
    return raw;
}
function loadStudyQuestionsFromConfig(extensionRoot, participantId) {
    const primaryConfigPath = path.join(extensionRoot, 'config', 'config.json');
    const fallbackConfigPath = path.join(extensionRoot, 'config', 'group.json');
    const configPath = fs.existsSync(primaryConfigPath) ? primaryConfigPath : fallbackConfigPath;
    if (!fs.existsSync(configPath)) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    catch {
        return undefined;
    }
    const normalizedId = participantId.trim();
    const prefix = normalizedId.split('_')[0];
    const matchedGroupKey = Object.prototype.hasOwnProperty.call(parsed, normalizedId)
        ? normalizedId
        : (Object.prototype.hasOwnProperty.call(parsed, prefix) ? prefix : undefined);
    const entries = matchedGroupKey ? parsed[matchedGroupKey] : undefined;
    if (!Array.isArray(entries)) {
        return undefined;
    }
    const questions = [];
    let queueIndex = 0;
    for (const entry of entries) {
        if (!entry || typeof entry.type !== 'string' || !Array.isArray(entry.item)) {
            continue;
        }
        for (const rawCaseId of entry.item) {
            const caseId = String(rawCaseId ?? '').trim();
            if (!caseId) {
                continue;
            }
            questions.push({
                queueIndex,
                caseId,
                explainType: entry.type
            });
            queueIndex += 1;
        }
    }
    return questions;
}
function loadQueryTemplate(caseRoot) {
    const queryPath = path.join(caseRoot, '__debug', 'query', 'query.json');
    if (!fs.existsSync(queryPath)) {
        return {};
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(queryPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return parsed;
    }
    catch {
        return {};
    }
}
function pickQuerySectionByPhase(query, phase) {
    const phaseKeys = phase === 'debugging'
        ? ['Question for Debugging', 'Debugging', 'question for debugging']
        : ['Question for Understanding', 'Understanding', 'question for understanding'];
    for (const key of phaseKeys) {
        const section = query[key];
        if (section && typeof section === 'object') {
            return { [key]: section };
        }
    }
    const allSections = Object.keys(query);
    if (allSections.length === 0) {
        return {};
    }
    if (phase === 'debugging') {
        const first = allSections[0];
        return { [first]: query[first] };
    }
    if (allSections.length > 1) {
        const second = allSections[1];
        return { [second]: query[second] };
    }
    const first = allSections[0];
    return { [first]: query[first] };
}
function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0].uri.fsPath;
}
function listAvailableCaseIds(workspaceRoot) {
    let entries = [];
    try {
        entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => Number(a) - Number(b));
}
function getActiveWorkspaceCaseRoot() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot || !currentId) {
        return undefined;
    }
    const candidate = path.join(workspaceRoot, currentId);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
        return undefined;
    }
    return candidate;
}
function getActiveDebugCaseRoot(extensionRoot) {
    if (!currentId) {
        return undefined;
    }
    const candidate = path.join(extensionRoot, 'data', currentId);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
        return undefined;
    }
    return candidate;
}
function collectPythonFiles(rootDir) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }
    const stack = [rootDir];
    const files = [];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.py')) {
                files.push(fullPath);
            }
        }
    }
    return files;
}
async function focusCaseSource(caseRoot) {
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(caseRoot));
    const srcRoot = path.join(caseRoot, 'src');
    const pythonFiles = collectPythonFiles(srcRoot);
    if (pythonFiles.length !== 1) {
        vscode.window.showErrorMessage(`Expected exactly one Python file under ${srcRoot}, found ${pythonFiles.length}.`);
        return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(pythonFiles[0]));
    await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
    });
}
function getMainStudyHtml(webview) {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Main Study</title>
	<style>
		body {
			margin: 0;
			padding: 16px;
			font-family: var(--vscode-font-family);
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
		}

		.hidden {
			display: none;
		}

		.top-bar {
			display: flex;
			gap: 8px;
			align-items: center;
			margin-bottom: 12px;
		}

		.id-input {
			flex: 1;
			min-width: 0;
			padding: 6px 8px;
			border-radius: 6px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
		}

		.header {
			font-size: 16px;
			font-weight: 600;
			margin-bottom: 12px;
		}

		.case-list {
			display: flex;
			flex-direction: column;
			gap: 10px;
		}

		.case-item {
			border: 1px solid var(--vscode-editorWidget-border);
			border-radius: 8px;
			padding: 10px 12px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
		}

		.case-id {
			font-size: 14px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		button {
			border: none;
			border-radius: 6px;
			padding: 6px 14px;
			cursor: pointer;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}

		button:hover {
			background: var(--vscode-button-hoverBackground);
		}

		button:disabled {
			cursor: not-allowed;
			color: var(--vscode-disabledForeground);
			background: var(--vscode-button-secondaryBackground);
		}

		.case-item.done {
			opacity: 0.7;
		}

		.case-item.done .case-id::after {
			content: '  (done)';
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
		}

		.empty {
			border: 1px dashed var(--vscode-editorWidget-border);
			border-radius: 8px;
			padding: 16px;
			color: var(--vscode-descriptionForeground);
		}

		.answer-wrap {
			min-height: 200px;
			height: calc(100vh - 48px);
			display: flex;
			flex-direction: column;
			gap: 12px;
			align-items: stretch;
		}

		.case-tag {
			font-size: 14px;
			color: var(--vscode-descriptionForeground);
			padding: 0 4px;
		}

		.question-form {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			border: 1px solid var(--vscode-editorWidget-border);
			border-radius: 8px;
			padding: 10px;
		}

		.q-section-title {
			font-size: 13px;
			font-weight: 600;
			margin: 6px 0 10px;
		}

		.q-divider {
			border: 0;
			height: 1px;
			background: var(--vscode-editorWidget-border);
			margin: 12px 0;
		}

		.q-item {
			display: flex;
			flex-direction: column;
			gap: 6px;
			margin-bottom: 12px;
		}

		.q-label {
			font-size: 12px;
			line-height: 1.4;
		}

		.q-input,
		.q-textarea {
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 6px;
			padding: 6px 8px;
		}

		.q-input {
			width: 180px;
		}

		.q-textarea {
			min-height: 72px;
			resize: vertical;
		}

		.q-judgement {
			display: flex;
			gap: 14px;
			align-items: center;
		}

		.answer-actions {
			display: flex;
			justify-content: flex-end;
		}

		.footer {
			margin-top: 16px;
			display: flex;
			justify-content: flex-end;
		}
	</style>
</head>
<body>
	<section id="libraryPage">
		<div class="top-bar">
			<input id="participantInput" class="id-input" type="text" placeholder="编号">
			<button id="loadOrClearBtn">Load</button>
		</div>
		<div class="header">Main Study Question</div>
		<div id="caseList" class="case-list"></div>
		<div class="footer">
			<button id="confirmBtn" class="hidden">Confirm</button>
		</div>
	</section>

	<section id="answerPage" class="hidden">
		<div class="answer-wrap">
			<div id="answerCaseTag" class="case-tag"></div>
			<div id="questionForm" class="question-form"></div>
			<div class="answer-actions">
				<button id="submitBtn">Submit</button>
			</div>
		</div>
	</section>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const libraryPage = document.getElementById('libraryPage');
		const answerPage = document.getElementById('answerPage');
		const caseList = document.getElementById('caseList');
		const answerCaseTag = document.getElementById('answerCaseTag');
		const submitBtn = document.getElementById('submitBtn');
		const questionForm = document.getElementById('questionForm');
		const participantInput = document.getElementById('participantInput');
		const loadOrClearBtn = document.getElementById('loadOrClearBtn');
		const confirmBtn = document.getElementById('confirmBtn');
		let state = {
			loaded: false,
			participantId: '',
			isAdmin: false,
			questions: [],
			nextCaseIndex: 0,
			canConfirm: false,
			pendingRtlxGroup: '',
			rtlxCompletedGroups: []
		};
		let answerDraft = {};
		let currentQuery = {};
		let currentPhase = 'debugging';

		function displayGroupLabel(explainType) {
			const raw = String(explainType || '').trim();
			if (raw === 'Explain by visualPilot') {
				return 'G1';
			}
			if (raw === 'Explain by pythonTutor') {
				return 'G2';
			}
			if (raw === 'Explain by llmGeneration') {
				return 'G3';
			}

			return raw;
		}

		function renderLibrary() {
			caseList.innerHTML = '';
			const questions = Array.isArray(state.questions) ? state.questions : [];
			const completedRtlx = new Set(Array.isArray(state.rtlxCompletedGroups) ? state.rtlxCompletedGroups : []);

			participantInput.value = state.participantId || '';
			participantInput.disabled = !!state.loaded;
			loadOrClearBtn.textContent = state.loaded ? 'Clear' : 'Load';

			if (!state.loaded) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = 'Please input id and click Load to fetch question bank.';
				caseList.appendChild(empty);
				confirmBtn.classList.add('hidden');
				return;
			}

			if (!Array.isArray(questions) || questions.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = 'No available case directories found.';
				caseList.appendChild(empty);
				if (state.isAdmin) {
					confirmBtn.classList.remove('hidden');
				} else {
					confirmBtn.classList.add('hidden');
				}
				return;
			}

			const groups = [];
			for (const q of questions) {
				const groupType = String(q.explainType || '');
				if (!groupType) {
					continue;
				}

				if (!groups.includes(groupType)) {
					groups.push(groupType);
				}
			}

			const groupQuestionsMap = new Map();
			for (const g of groups) {
				groupQuestionsMap.set(g, questions.filter((q) => q.explainType === g));
			}

			let activeGroup = '';
			const nextIndex = Number(state.nextCaseIndex || 0);
			if (nextIndex >= 0 && nextIndex < questions.length) {
				activeGroup = String(questions[nextIndex].explainType || '');
			}

			let visibleGroupCount = groups.length;
			if (!state.isAdmin) {
				if (state.pendingRtlxGroup) {
					visibleGroupCount = Math.max(1, groups.indexOf(state.pendingRtlxGroup) + 1);
				} else if (activeGroup) {
					visibleGroupCount = Math.max(1, groups.indexOf(activeGroup) + 1);
				}
			}

			for (let gIndex = 0; gIndex < groups.length; gIndex += 1) {
				const groupType = groups[gIndex];
				if (!state.isAdmin && gIndex >= visibleGroupCount) {
					break;
				}

				const groupHeader = document.createElement('div');
				groupHeader.className = 'header';
				groupHeader.style.marginTop = '8px';
				groupHeader.style.marginBottom = '6px';
				groupHeader.textContent = displayGroupLabel(groupType);
				caseList.appendChild(groupHeader);

				const groupQuestions = groupQuestionsMap.get(groupType) || [];

				if (groupQuestions.length === 0) {
					const emptyGroup = document.createElement('div');
					emptyGroup.className = 'empty';
					emptyGroup.textContent = 'No questions in this group.';
					caseList.appendChild(emptyGroup);
					continue;
				}

				for (const question of groupQuestions) {
					const index = Number(question.queueIndex || 0);
					const row = document.createElement('div');
					row.className = 'case-item';
					if (!state.isAdmin && index < Number(state.nextCaseIndex || 0)) {
						row.classList.add('done');
					}

					const label = document.createElement('div');
					label.className = 'case-id';
					label.textContent = String(question.caseId || '');

					const startBtn = document.createElement('button');
					startBtn.textContent = 'Start';
					const enabled = state.isAdmin || index === Number(state.nextCaseIndex || 0);
					startBtn.disabled = !enabled;
					startBtn.addEventListener('click', () => {
						vscode.postMessage({
							command: 'startCase',
							queueIndex: index
						});
					});

					row.appendChild(label);
					row.appendChild(startBtn);
					caseList.appendChild(row);
				}

				if (!state.isAdmin) {
					const groupDone = groupQuestions.length > 0 && groupQuestions.every((q) => Number(q.queueIndex) < nextIndex);
					const needsRtlx = groupDone && !completedRtlx.has(groupType);
					if (needsRtlx) {
						const rtlxRow = document.createElement('div');
						rtlxRow.className = 'case-item';
						const label = document.createElement('div');
						label.className = 'case-id';
						label.textContent = 'Post-Task: Self-Assessment';

						const btn = document.createElement('button');
						btn.textContent = 'Feedback';
						btn.addEventListener('click', () => {
							vscode.postMessage({ command: 'openRtlx', groupType });
						});

						rtlxRow.appendChild(label);
						rtlxRow.appendChild(btn);
						caseList.appendChild(rtlxRow);
					}
				}
			}

			if (state.canConfirm) {
				confirmBtn.classList.remove('hidden');
			} else {
				confirmBtn.classList.add('hidden');
			}
		}

		function showLibrary() {
			renderLibrary();
			answerPage.classList.add('hidden');
			libraryPage.classList.remove('hidden');
		}

		function createEmptyDraft(queryData) {
			const draft = {};
			if (!queryData || typeof queryData !== 'object') {
				return draft;
			}

			for (const sectionName of Object.keys(queryData)) {
				const section = queryData[sectionName];
				if (!section || typeof section !== 'object') {
					continue;
				}

				draft[sectionName] = {};
				for (const questionId of Object.keys(section)) {
					const q = section[questionId] || {};
					draft[sectionName][questionId] = {
						type: String(q.type || ''),
						content: String(q.content || ''),
						response: ''
					};
				}
			}

			return draft;
		}

		function renderQuestions() {
			questionForm.innerHTML = '';
			const orderedSections = ['Question for Debugging', 'Question for Understanding'];
			let renderedAny = false;

			for (let sIndex = 0; sIndex < orderedSections.length; sIndex += 1) {
				const sectionName = orderedSections[sIndex];
				const section = currentQuery[sectionName];
				if (!section || typeof section !== 'object') {
					continue;
				}

				renderedAny = true;
				if (sIndex > 0) {
					const divider = document.createElement('hr');
					divider.className = 'q-divider';
					questionForm.appendChild(divider);
				}

				const title = document.createElement('div');
				title.className = 'q-section-title';
				title.textContent = sectionName;
				questionForm.appendChild(title);

				for (const questionId of Object.keys(section)) {
					const q = section[questionId] || {};
					const qType = String(q.type || 'text');
					const qContent = String(q.content || '');
					if (!answerDraft[sectionName]) {
						answerDraft[sectionName] = {};
					}
					if (!answerDraft[sectionName][questionId]) {
						answerDraft[sectionName][questionId] = {
							type: qType,
							content: qContent,
							response: ''
						};
					}

					const row = document.createElement('div');
					row.className = 'q-item';

					const label = document.createElement('label');
					label.className = 'q-label';
					label.textContent = questionId + '. ' + qContent;
					row.appendChild(label);

					if (qType === 'number') {
						const input = document.createElement('input');
						input.type = 'number';
						input.className = 'q-input';
						input.value = String(answerDraft[sectionName][questionId].response || '');
						input.addEventListener('input', () => {
							answerDraft[sectionName][questionId].response = input.value;
						});
						row.appendChild(input);
					} else if (qType === 'judgement') {
						const wrap = document.createElement('div');
						wrap.className = 'q-judgement';
						const name = sectionName + '__' + questionId;

						const trueLabel = document.createElement('label');
						const trueRadio = document.createElement('input');
						trueRadio.type = 'radio';
						trueRadio.name = name;
						trueRadio.value = 'true';
						trueRadio.checked = answerDraft[sectionName][questionId].response === 'true';
						trueRadio.addEventListener('change', () => {
							if (trueRadio.checked) {
								answerDraft[sectionName][questionId].response = 'true';
							}
						});
						trueLabel.appendChild(trueRadio);
						trueLabel.appendChild(document.createTextNode(' 对'));

						const falseLabel = document.createElement('label');
						const falseRadio = document.createElement('input');
						falseRadio.type = 'radio';
						falseRadio.name = name;
						falseRadio.value = 'false';
						falseRadio.checked = answerDraft[sectionName][questionId].response === 'false';
						falseRadio.addEventListener('change', () => {
							if (falseRadio.checked) {
								answerDraft[sectionName][questionId].response = 'false';
							}
						});
						falseLabel.appendChild(falseRadio);
						falseLabel.appendChild(document.createTextNode(' 错'));

						wrap.appendChild(trueLabel);
						wrap.appendChild(falseLabel);
						row.appendChild(wrap);
					} else {
						const textarea = document.createElement('textarea');
						textarea.className = 'q-textarea';
						textarea.value = String(answerDraft[sectionName][questionId].response || '');
						textarea.addEventListener('input', () => {
							answerDraft[sectionName][questionId].response = textarea.value;
						});
						row.appendChild(textarea);
					}

					questionForm.appendChild(row);
				}
			}

			if (!renderedAny) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = 'No query questions found under __debug/query/query.json.';
				questionForm.appendChild(empty);
			}
		}

		function getPhaseLabel(phase) {
			if (phase === 'understanding') {
				return 'Question for Understanding';
			}

			return 'Question for Debugging';
		}

		function showAnswer(caseId, queryData, phase) {
			currentPhase = phase === 'understanding' ? 'understanding' : 'debugging';
			answerCaseTag.textContent = caseId ? ('Current Case: ' + caseId) : '';
			currentQuery = queryData && typeof queryData === 'object' ? queryData : {};
			answerDraft = createEmptyDraft(currentQuery);
			submitBtn.textContent = currentPhase === 'debugging' ? 'Submit' : 'Submit';
			const label = getPhaseLabel(currentPhase);
			if (answerCaseTag.textContent) {
				answerCaseTag.textContent += ' · ' + label;
			} else {
				answerCaseTag.textContent = label;
			}
			renderQuestions();
			libraryPage.classList.add('hidden');
			answerPage.classList.remove('hidden');
		}

		submitBtn.addEventListener('click', () => {
			vscode.postMessage({ command: 'submit', phase: currentPhase, queryAnswer: answerDraft });
		});

		loadOrClearBtn.addEventListener('click', () => {
			if (state.loaded) {
				vscode.postMessage({ command: 'clearToken' });
				return;
			}

			vscode.postMessage({
				command: 'loadToken',
				participantId: participantInput.value || ''
			});
		});

		confirmBtn.addEventListener('click', () => {
			vscode.postMessage({ command: 'confirm' });
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.command === 'renderMainStudy') {
				state = {
					loaded: !!message.loaded,
					participantId: message.participantId || '',
					isAdmin: !!message.isAdmin,
					questions: Array.isArray(message.questions) ? message.questions : [],
					nextCaseIndex: Number(message.nextCaseIndex || 0),
					canConfirm: !!message.canConfirm,
					pendingRtlxGroup: message.pendingRtlxGroup || '',
					rtlxCompletedGroups: Array.isArray(message.rtlxCompletedGroups) ? message.rtlxCompletedGroups : []
				};
				showLibrary();
				return;
			}

			if (message.command === 'showAnswer') {
				showAnswer(message.caseId || '', message.queryData || {}, message.phase || 'debugging');
				return;
			}

			if (message.command === 'showAnswerPhase') {
				showAnswer(message.caseId || '', message.queryData || {}, message.phase || 'debugging');
			}
		});

		vscode.postMessage({ command: 'ready' });
	</script>
</body>
</html>`;
}
function getRtlxHtml(webview, groupType) {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const groupLabel = toGroupLabel(groupType);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>阶段自评：工具使用感受</title>
	<style>
		body { margin: 0; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
		h1 { margin: 0 0 8px; font-size: 18px; }
		.sub { margin: 0 0 14px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
		.group { margin: 0 0 14px; font-size: 12px; color: var(--vscode-textLink-foreground); }
		.item { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
		.item-title { font-size: 13px; margin-bottom: 6px; }
		.item-desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; line-height: 1.4; }
		.scale { display: flex; gap: 8px; align-items: center; }
		.scale-label { width: 110px; font-size: 11px; color: var(--vscode-descriptionForeground); }
		input[type="range"] { flex: 1; }
		.scale-value { width: 40px; text-align: right; font-size: 12px; }
		textarea { width: 100%; min-height: 90px; resize: vertical; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 8px; }
		.actions { margin-top: 12px; display: flex; justify-content: flex-end; }
		button { border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button:disabled { cursor: not-allowed; background: var(--vscode-button-secondaryBackground); color: var(--vscode-disabledForeground); }
	</style>
</head>
<body>
	<h1>阶段自评：工具使用感受</h1>
	<p class="sub">请根据您使用当前工具处理刚才几个任务的真实感受进行打分。您的直觉反馈对我们的研究至关重要。</p>
	<div class="group">当前组别：${groupLabel}</div>

	<div id="form"></div>

	<div class="item">
		<div class="item-title">自由反馈</div>
		<textarea id="feedback" placeholder="可选：记录你的感受、建议或问题"></textarea>
	</div>

	<div class="actions">
		<button id="submitBtn" disabled>提交并进入下一组</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const dimensions = [
			{ key: 'mentalDemand', name: 'Mental Demand (脑力需求)', desc: '理解代码逻辑、追踪变量变化、建立心理模型有多累？', left: '非常简单', right: '非常烧脑' },
			{ key: 'physicalDemand', name: 'Physical Demand (体力需求)', desc: '频繁点击、拖拽、滚动操作是否繁琐？', left: '轻松', right: '极度繁琐' },
			{ key: 'temporalDemand', name: 'Temporal Demand (时间压力)', desc: '在规定时间内定位并理解 Bug，你感到紧迫吗？', left: '游刃有余', right: '极度紧迫' },
			{ key: 'performance', name: 'Performance (表现/成功度)', desc: '你对自己找到 Bug 并给出正确修复方案的信心如何？', left: '毫无信心', right: '充满信心' },
			{ key: 'effort', name: 'Effort (努力程度)', desc: '为了达到目前表现，你在思维和操作上付出了多少努力？', left: '非常少', right: '极度努力' },
			{ key: 'frustration', name: 'Frustration (挫败感)', desc: '使用该工具过程中是否感到焦虑、愤怒或气馁？', left: '毫无感觉', right: '非常沮丧' }
		];

		const touched = new Set();
		const values = {};
		const form = document.getElementById('form');
		const submitBtn = document.getElementById('submitBtn');

		function updateSubmitEnabled() {
			submitBtn.disabled = touched.size !== dimensions.length;
		}

		for (const dim of dimensions) {
			const wrap = document.createElement('div');
			wrap.className = 'item';

			const title = document.createElement('div');
			title.className = 'item-title';
			title.textContent = dim.name;
			wrap.appendChild(title);

			const desc = document.createElement('div');
			desc.className = 'item-desc';
			desc.textContent = dim.desc;
			wrap.appendChild(desc);

			const scale = document.createElement('div');
			scale.className = 'scale';

			const left = document.createElement('div');
			left.className = 'scale-label';
			left.textContent = dim.left;

			const slider = document.createElement('input');
			slider.type = 'range';
			slider.min = '0';
			slider.max = '100';
			slider.step = '5';
			slider.value = '50';

			const right = document.createElement('div');
			right.className = 'scale-label';
			right.textContent = dim.right;

			const value = document.createElement('div');
			value.className = 'scale-value';
			value.textContent = slider.value;

			slider.addEventListener('input', () => {
				value.textContent = slider.value;
				values[dim.key] = Number(slider.value);
				touched.add(dim.key);
				updateSubmitEnabled();
			});

			scale.appendChild(left);
			scale.appendChild(slider);
			scale.appendChild(right);
			scale.appendChild(value);
			wrap.appendChild(scale);

			form.appendChild(wrap);
		}

		submitBtn.addEventListener('click', () => {
			vscode.postMessage({
				command: 'submitRtlx',
				group: ${JSON.stringify(groupType)},
				scores: values,
				feedback: document.getElementById('feedback').value || ''
			});
		});
	</script>
</body>
</html>`;
}
function activate(context) {
    let mainStudyPanel;
    let rtlxPanel;
    let participantId = '';
    let loadedQuestionBank = false;
    let isAdminMode = false;
    let orderedQuestions = [];
    let nextCaseIndex = 0;
    let pendingRtlxGroupType;
    let rtlxCompletedGroups = new Set();
    let activeAnswerCaseId;
    let activeExplainType;
    let activeAnswerRecordIndex;
    let activeAnswerPhase;
    let activeQueryTemplate;
    let mainResultFilePath;
    let mainResultRecord;
    const persistMainResult = () => {
        if (!mainResultFilePath || !mainResultRecord) {
            return;
        }
        try {
            fs.writeFileSync(mainResultFilePath, JSON.stringify(mainResultRecord, null, 2), 'utf8');
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to write main result file: ${String(error)}`);
        }
    };
    const copyResultToWorkspace = () => {
        if (!mainResultFilePath || !fs.existsSync(mainResultFilePath)) {
            return;
        }
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            return;
        }
        try {
            const workspaceResultDir = path.join(workspaceRoot, 'result');
            fs.mkdirSync(workspaceResultDir, { recursive: true });
            const sourceBaseName = path.basename(mainResultFilePath);
            const targetBaseName = sourceBaseName.startsWith('Main_')
                ? sourceBaseName.replace(/^Main_/, 'result_')
                : sourceBaseName;
            const destinationPath = path.join(workspaceResultDir, targetBaseName);
            fs.copyFileSync(mainResultFilePath, destinationPath);
            vscode.window.showInformationMessage(`Result copied to workspace: ${destinationPath}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to copy result to workspace: ${String(error)}`);
        }
    };
    const postMainStudyState = () => {
        const canConfirm = isAdminMode || (loadedQuestionBank &&
            orderedQuestions.length > 0 &&
            nextCaseIndex >= orderedQuestions.length &&
            !pendingRtlxGroupType);
        mainStudyPanel?.webview.postMessage({
            command: 'renderMainStudy',
            loaded: loadedQuestionBank,
            participantId,
            isAdmin: isAdminMode,
            questions: loadedQuestionBank ? orderedQuestions : [],
            nextCaseIndex,
            canConfirm,
            pendingRtlxGroup: pendingRtlxGroupType ?? '',
            rtlxCompletedGroups: Array.from(rtlxCompletedGroups)
        });
    };
    const resetMainStudyState = () => {
        participantId = '';
        loadedQuestionBank = false;
        isAdminMode = false;
        orderedQuestions = [];
        nextCaseIndex = 0;
        pendingRtlxGroupType = undefined;
        rtlxCompletedGroups = new Set();
        activeAnswerCaseId = undefined;
        activeExplainType = undefined;
        activeAnswerRecordIndex = undefined;
        activeAnswerPhase = undefined;
        activeQueryTemplate = undefined;
        mainResultFilePath = undefined;
        mainResultRecord = undefined;
    };
    const traceViewProvider = new TraceViewProvider_1.TraceViewProvider(context.extensionUri, () => getActiveDebugCaseRoot(context.extensionUri.fsPath), () => getActiveWorkspaceCaseRoot());
    const slidesOverlayController = new SlidesOverlayController_1.SlidesOverlayController(context, context.extensionUri, async (block) => {
        if (!block) {
            traceViewProvider.clearPlaybackHighlight();
            return;
        }
        await traceViewProvider.highlightPlaybackBlock(block);
    }, async (blocks) => {
        if (!blocks.length) {
            traceViewProvider.clearPlaybackHighlight();
            return;
        }
        await traceViewProvider.showAllPlaybackBlocks(blocks);
    }, () => getActiveDebugCaseRoot(context.extensionUri.fsPath));
    const llmGenerationController = new LlmGenerationController_1.LlmGenerationController(context.extensionUri, () => getActiveDebugCaseRoot(context.extensionUri.fsPath));
    const pythonTutorController = new PythonTutorController_1.PythonTutorController(context.extensionUri, async (block) => {
        if (!block) {
            traceViewProvider.clearPlaybackHighlight();
            return;
        }
        const traceStart = typeof block.tstart === 'number'
            ? block.tstart
            : block.id;
        const traceEnd = typeof block.tend === 'number'
            ? block.tend
            : traceStart;
        await traceViewProvider.highlightPlaybackBlock({
            id: block.id,
            name: block.name,
            start: 0,
            end: 0,
            tstart: traceStart,
            tend: traceEnd,
            cstart: block.cstart,
            cend: block.cend,
            file: block.file
        });
    }, () => getActiveDebugCaseRoot(context.extensionUri.fsPath));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(TraceViewProvider_1.TraceViewProvider.viewType, traceViewProvider, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    }));
    const refreshTraceCommand = vscode.commands.registerCommand('Execution_Visual_Study.refreshTrace', () => {
        traceViewProvider.refresh();
        vscode.window.showInformationMessage('Trace data refreshed');
    });
    const openTraceViewerCommand = vscode.commands.registerCommand('Execution_Visual_Study.openTraceViewer', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.visualpilot-trace-explorer');
    });
    const explainByVisualPilotCommand = vscode.commands.registerCommand('Execution_Visual_Study.explainByVisualPilot', async () => {
        await pythonTutorController.close();
        await llmGenerationController.close();
        await slidesOverlayController.play();
    });
    const explainByPythonTutorCommand = vscode.commands.registerCommand('Execution_Visual_Study.explainByPythonTutor', async () => {
        await slidesOverlayController.close();
        await llmGenerationController.close();
        await pythonTutorController.play();
    });
    const explainByLlmGenerationCommand = vscode.commands.registerCommand('Execution_Visual_Study.explainByLlmGeneration', async () => {
        await pythonTutorController.close();
        await slidesOverlayController.close();
        await llmGenerationController.play();
        await llmGenerationController.setPhase(activeAnswerPhase === 'understanding' ? 'understanding' : 'debugging');
    });
    const showMainStudyCommand = vscode.commands.registerCommand('Execution_Visual_Study.showMainStudy', async () => {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        if (mainStudyPanel) {
            mainStudyPanel.reveal(vscode.ViewColumn.Beside, true);
            postMainStudyState();
            return;
        }
        mainStudyPanel = vscode.window.createWebviewPanel('Execution_Visual_StudyMainStudy', 'Main Study', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        mainStudyPanel.webview.html = getMainStudyHtml(mainStudyPanel.webview);
        const onDispose = mainStudyPanel.onDidDispose(() => {
            rtlxPanel?.dispose();
            rtlxPanel = undefined;
            resetMainStudyState();
            currentId = undefined;
            mainStudyPanel = undefined;
        });
        const onMessage = mainStudyPanel.webview.onDidReceiveMessage(async (message) => {
            const activeWorkspaceRoot = getWorkspaceRoot();
            if (!activeWorkspaceRoot) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            if (message.command === 'ready') {
                postMainStudyState();
                return;
            }
            if (message.command === 'loadToken') {
                if (loadedQuestionBank) {
                    return;
                }
                const nextParticipantId = String(message.participantId ?? '').trim();
                if (!nextParticipantId) {
                    vscode.window.showWarningMessage('Please input id before loading question bank.');
                    return;
                }
                participantId = nextParticipantId;
                loadedQuestionBank = true;
                isAdminMode = participantId.toLowerCase() === 'admin';
                const configuredQuestions = loadStudyQuestionsFromConfig(context.extensionUri.fsPath, participantId);
                if (!configuredQuestions) {
                    loadedQuestionBank = false;
                    isAdminMode = false;
                    participantId = '';
                    vscode.window.showErrorMessage('No matched id in config/config.json. Please check and retry.');
                    postMainStudyState();
                    return;
                }
                orderedQuestions = configuredQuestions;
                nextCaseIndex = 0;
                pendingRtlxGroupType = undefined;
                rtlxCompletedGroups = new Set();
                activeAnswerCaseId = undefined;
                activeExplainType = undefined;
                activeAnswerRecordIndex = undefined;
                activeAnswerPhase = undefined;
                activeQueryTemplate = undefined;
                const resultDir = path.join(context.extensionUri.fsPath, 'result');
                fs.mkdirSync(resultDir, { recursive: true });
                const fileTime = toTimestampForFile(new Date());
                const safeId = sanitizeForFileName(participantId);
                mainResultFilePath = path.join(resultDir, `result_${safeId}_${fileTime}.json`);
                mainResultRecord = {
                    id: participantId,
                    main_start: toIsoTime(new Date()),
                    main_end: '',
                    answer: [],
                    rtlx: []
                };
                persistMainResult();
                postMainStudyState();
                return;
            }
            if (message.command === 'clearToken') {
                await slidesOverlayController.close();
                await llmGenerationController.close();
                await pythonTutorController.close();
                rtlxPanel?.dispose();
                rtlxPanel = undefined;
                currentId = undefined;
                traceViewProvider.clearTraceData();
                if (mainResultFilePath) {
                    try {
                        if (fs.existsSync(mainResultFilePath)) {
                            fs.unlinkSync(mainResultFilePath);
                        }
                    }
                    catch (error) {
                        vscode.window.showErrorMessage(`Failed to delete main result file: ${String(error)}`);
                    }
                }
                resetMainStudyState();
                postMainStudyState();
                return;
            }
            if (message.command === 'startCase') {
                if (!loadedQuestionBank) {
                    vscode.window.showWarningMessage('Please load question bank first.');
                    return;
                }
                const selectedIndex = Number(message.queueIndex);
                if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= orderedQuestions.length) {
                    vscode.window.showErrorMessage('Invalid question index.');
                    return;
                }
                if (!isAdminMode && selectedIndex !== nextCaseIndex) {
                    vscode.window.showWarningMessage('Please answer questions from top to bottom in order.');
                    return;
                }
                if (!isAdminMode && pendingRtlxGroupType) {
                    vscode.window.showWarningMessage('Please complete the RTLX questionnaire for the finished group before entering the next group.');
                    return;
                }
                const selectedQuestion = orderedQuestions[selectedIndex];
                const selectedId = selectedQuestion.caseId;
                const workspaceCaseRoot = path.join(activeWorkspaceRoot, selectedId);
                if (!fs.existsSync(workspaceCaseRoot) || !fs.statSync(workspaceCaseRoot).isDirectory()) {
                    vscode.window.showErrorMessage(`Case directory not found: ${selectedId}`);
                    return;
                }
                const debugCaseRoot = path.join(context.extensionUri.fsPath, 'data', selectedId);
                if (!fs.existsSync(debugCaseRoot) || !fs.statSync(debugCaseRoot).isDirectory()) {
                    vscode.window.showErrorMessage(`Debug data directory not found: data/${selectedId}`);
                    return;
                }
                currentId = selectedId;
                activeAnswerCaseId = selectedId;
                activeExplainType = selectedQuestion.explainType;
                activeAnswerPhase = 'debugging';
                const queryTemplate = loadQueryTemplate(debugCaseRoot);
                activeQueryTemplate = queryTemplate;
                const now = toIsoTime(new Date());
                if (mainResultRecord) {
                    mainResultRecord.answer.push({
                        case_id: selectedId,
                        question: `${selectedQuestion.explainType}:${selectedId}`,
                        answer: '',
                        single_start: now,
                        single_end: '',
                        debugging_start: now,
                        debugging_end: '',
                        understanding_start: '',
                        understanding_end: ''
                    });
                    activeAnswerRecordIndex = mainResultRecord.answer.length - 1;
                    persistMainResult();
                }
                mainStudyPanel?.webview.postMessage({
                    command: 'showAnswer',
                    caseId: currentId,
                    phase: 'debugging',
                    queryData: pickQuerySectionByPhase(queryTemplate, 'debugging')
                });
                await focusCaseSource(workspaceCaseRoot);
                traceViewProvider.refresh();
                await vscode.commands.executeCommand('workbench.view.extension.visualpilot-trace-explorer');
                await vscode.commands.executeCommand(getExplainCommandByType(selectedQuestion.explainType));
                return;
            }
            if (message.command === 'submit') {
                if (!activeAnswerCaseId) {
                    vscode.window.showWarningMessage('No active question to submit.');
                    return;
                }
                const queryAnswer = message.queryAnswer && typeof message.queryAnswer === 'object'
                    ? message.queryAnswer
                    : {};
                const phase = activeAnswerPhase === 'understanding' ? 'understanding' : 'debugging';
                const now = toIsoTime(new Date());
                if (mainResultRecord && typeof activeAnswerRecordIndex === 'number') {
                    const activeRecord = mainResultRecord.answer[activeAnswerRecordIndex];
                    if (activeRecord) {
                        if (phase === 'debugging') {
                            activeRecord.debugging_end = now;
                            activeRecord.debugging_query_answer = queryAnswer;
                        }
                        else {
                            activeRecord.understanding_end = now;
                            activeRecord.understanding_query_answer = queryAnswer;
                            activeRecord.single_end = now;
                            activeRecord.query_answer = queryAnswer;
                            activeRecord.answer = JSON.stringify({
                                debugging: activeRecord.debugging_query_answer ?? {},
                                understanding: activeRecord.understanding_query_answer ?? {}
                            });
                        }
                    }
                }
                if (phase === 'debugging') {
                    activeAnswerPhase = 'understanding';
                    if (mainResultRecord && typeof activeAnswerRecordIndex === 'number') {
                        const activeRecord = mainResultRecord.answer[activeAnswerRecordIndex];
                        if (activeRecord) {
                            activeRecord.understanding_start = now;
                        }
                    }
                    persistMainResult();
                    if (activeExplainType === 'Explain by llmGeneration') {
                        await llmGenerationController.setPhase('understanding');
                    }
                    mainStudyPanel?.webview.postMessage({
                        command: 'showAnswerPhase',
                        caseId: activeAnswerCaseId,
                        phase: 'understanding',
                        queryData: pickQuerySectionByPhase(activeQueryTemplate ?? {}, 'understanding')
                    });
                    return;
                }
                await slidesOverlayController.close();
                await llmGenerationController.close();
                await pythonTutorController.close();
                if (mainStudyPanel) {
                    mainStudyPanel.reveal(vscode.ViewColumn.Beside, false);
                    await vscode.commands.executeCommand('workbench.action.closeOtherEditors');
                    await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups');
                }
                if (!isAdminMode && nextCaseIndex < orderedQuestions.length) {
                    const expected = orderedQuestions[nextCaseIndex];
                    if (expected.caseId === activeAnswerCaseId && expected.explainType === activeExplainType) {
                        nextCaseIndex += 1;
                    }
                }
                if (!isAdminMode && activeExplainType) {
                    const groupDone = orderedQuestions
                        .filter((q) => q.explainType === activeExplainType)
                        .every((q) => q.queueIndex < nextCaseIndex);
                    if (groupDone && !rtlxCompletedGroups.has(activeExplainType)) {
                        pendingRtlxGroupType = activeExplainType;
                    }
                }
                if (mainResultRecord &&
                    !mainResultRecord.main_end &&
                    !isAdminMode &&
                    orderedQuestions.length > 0 &&
                    nextCaseIndex >= orderedQuestions.length &&
                    !pendingRtlxGroupType) {
                    mainResultRecord.main_end = toIsoTime(new Date());
                }
                activeAnswerCaseId = undefined;
                activeExplainType = undefined;
                activeAnswerRecordIndex = undefined;
                activeAnswerPhase = undefined;
                activeQueryTemplate = undefined;
                currentId = undefined;
                traceViewProvider.clearTraceData();
                persistMainResult();
                postMainStudyState();
                return;
            }
            if (message.command === 'openRtlx') {
                const groupType = String(message.groupType ?? '').trim();
                if (!groupType) {
                    return;
                }
                if (!pendingRtlxGroupType || pendingRtlxGroupType !== groupType) {
                    vscode.window.showWarningMessage('RTLX is only available for the current completed group.');
                    return;
                }
                if (rtlxPanel) {
                    rtlxPanel.reveal(vscode.ViewColumn.Beside, true);
                    return;
                }
                rtlxPanel = vscode.window.createWebviewPanel('Execution_Visual_StudyRtlx', '阶段自评：工具使用感受', vscode.ViewColumn.Beside, {
                    enableScripts: true,
                    retainContextWhenHidden: true
                });
                rtlxPanel.webview.html = getRtlxHtml(rtlxPanel.webview, groupType);
                const rtlxDispose = rtlxPanel.onDidDispose(() => {
                    rtlxPanel = undefined;
                });
                const rtlxMessage = rtlxPanel.webview.onDidReceiveMessage((rtlxMessageData) => {
                    if (rtlxMessageData.command !== 'submitRtlx') {
                        return;
                    }
                    const submittedGroup = String(rtlxMessageData.group ?? '').trim();
                    if (!submittedGroup || submittedGroup !== pendingRtlxGroupType) {
                        vscode.window.showWarningMessage('RTLX submit group mismatch.');
                        return;
                    }
                    if (mainResultRecord) {
                        if (!Array.isArray(mainResultRecord.rtlx)) {
                            mainResultRecord.rtlx = [];
                        }
                        mainResultRecord.rtlx.push({
                            group: submittedGroup,
                            scores: {
                                mentalDemand: Number(rtlxMessageData.scores?.mentalDemand ?? 0),
                                physicalDemand: Number(rtlxMessageData.scores?.physicalDemand ?? 0),
                                temporalDemand: Number(rtlxMessageData.scores?.temporalDemand ?? 0),
                                performance: Number(rtlxMessageData.scores?.performance ?? 0),
                                effort: Number(rtlxMessageData.scores?.effort ?? 0),
                                frustration: Number(rtlxMessageData.scores?.frustration ?? 0)
                            },
                            feedback: String(rtlxMessageData.feedback ?? ''),
                            submitted_at: toIsoTime(new Date())
                        });
                    }
                    rtlxCompletedGroups.add(submittedGroup);
                    pendingRtlxGroupType = undefined;
                    if (mainResultRecord && !mainResultRecord.main_end && !isAdminMode && orderedQuestions.length > 0 && nextCaseIndex >= orderedQuestions.length) {
                        mainResultRecord.main_end = toIsoTime(new Date());
                    }
                    persistMainResult();
                    postMainStudyState();
                    rtlxPanel?.dispose();
                });
                context.subscriptions.push(rtlxDispose, rtlxMessage);
                return;
            }
            if (message.command === 'confirm') {
                const canConfirm = isAdminMode || (loadedQuestionBank &&
                    orderedQuestions.length > 0 &&
                    nextCaseIndex >= orderedQuestions.length &&
                    !pendingRtlxGroupType);
                if (!canConfirm) {
                    vscode.window.showWarningMessage('Please complete all questions before confirming.');
                    return;
                }
                if (mainResultRecord && !mainResultRecord.main_end) {
                    mainResultRecord.main_end = toIsoTime(new Date());
                    persistMainResult();
                }
                copyResultToWorkspace();
                await slidesOverlayController.close();
                await llmGenerationController.close();
                await pythonTutorController.close();
                rtlxPanel?.dispose();
                rtlxPanel = undefined;
                mainStudyPanel?.dispose();
            }
        });
        context.subscriptions.push(onDispose, onMessage);
    });
    const terminateSlidesCommand = vscode.commands.registerCommand('Execution_Visual_Study.terminateSlides', async () => {
        await slidesOverlayController.terminate();
    });
    context.subscriptions.push(refreshTraceCommand, openTraceViewerCommand, explainByVisualPilotCommand, explainByPythonTutorCommand, explainByLlmGenerationCommand, showMainStudyCommand, terminateSlidesCommand, slidesOverlayController, llmGenerationController, pythonTutorController);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map