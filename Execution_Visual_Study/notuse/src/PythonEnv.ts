import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const CONDA_DATA_ENV = 'C:/Users/user/.conda/envs/data';

export function getPreferredPythonPath(): string {
    const candidate = path.join(CONDA_DATA_ENV, 'python.exe');
    if (fs.existsSync(candidate)) {
        return candidate;
    }

    return 'python';
}

export async function resolvePythonPath(outputChannel?: vscode.OutputChannel): Promise<string> {
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

            const exports = pythonExtension.exports as {
                settings?: {
                    getExecutionDetails?: (resource?: vscode.Uri) => { execCommand?: string[] };
                };
            };

            const details = exports.settings?.getExecutionDetails?.(workspaceFolders[0].uri);
            if (details?.execCommand?.length) {
                outputChannel?.appendLine(`Conda env not found at ${CONDA_DATA_ENV}. Using Python extension interpreter: ${details.execCommand[0]}`);
                return details.execCommand[0];
            }
        }
    } catch (error) {
        outputChannel?.appendLine(`Failed to get Python path from extension. ${String(error)}`);
    }

    outputChannel?.appendLine(`Conda env not found at ${CONDA_DATA_ENV}. Falling back to python in PATH.`);
    return 'python';
}
