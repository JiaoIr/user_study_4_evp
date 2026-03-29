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
exports.getPreferredPythonPath = getPreferredPythonPath;
exports.resolvePythonPath = resolvePythonPath;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const CONDA_DATA_ENV = 'C:/Users/user/.conda/envs/data';
function getPreferredPythonPath() {
    const candidate = path.join(CONDA_DATA_ENV, 'python.exe');
    if (fs.existsSync(candidate)) {
        return candidate;
    }
    return 'python';
}
async function resolvePythonPath(outputChannel) {
    const preferred = getPreferredPythonPath();
    if (preferred !== 'python') {
        outputChannel?.appendLine(`Using configured conda Python: ${preferred}`);
        return preferred;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        outputChannel?.appendLine('No workspace folder found. Falling back to python in PATH.');
        return 'python';
    }
    try {
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (pythonExtension) {
            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }
            const exports = pythonExtension.exports;
            const details = exports.settings?.getExecutionDetails?.(workspaceFolders[0].uri);
            if (details?.execCommand?.length) {
                outputChannel?.appendLine(`Conda env not found at ${CONDA_DATA_ENV}. Using Python extension interpreter: ${details.execCommand[0]}`);
                return details.execCommand[0];
            }
        }
    }
    catch (error) {
        outputChannel?.appendLine(`Failed to get Python path from extension. ${String(error)}`);
    }
    outputChannel?.appendLine(`Conda env not found at ${CONDA_DATA_ENV}. Falling back to python in PATH.`);
    return 'python';
}
//# sourceMappingURL=PythonEnv.js.map