'use strict';

import * as cp from 'child_process';
import { NodeStringDecoder, StringDecoder } from 'string_decoder';

import * as vscode from 'vscode';

import { ThrottledDelayer } from './utils/async';

export interface LintItem {
    module: string;
    decl: string;
    severity: string;
    hint: string;
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    from: string;
    to: string;
    note: string[];
}

export class LineDecoder {
    private stringDecoder: NodeStringDecoder;
    private remaining: string;

    constructor(encoding: string = 'utf8') {
        this.stringDecoder = new StringDecoder(encoding);
        this.remaining = null;
    }

    public write(buffer: NodeBuffer): string[] {
        let result: string[] = [];
        let value = this.remaining
            ? this.remaining + this.stringDecoder.write(buffer)
            : this.stringDecoder.write(buffer);

        if (value.length < 1) {
            return result;
        }
        let start = 0;
        let ch: number;
        while (start < value.length && ((ch = value.charCodeAt(start)) === 13 || ch === 10)) {
            start++;
        }
        let idx = start;
        while (idx < value.length) {
            ch = value.charCodeAt(idx);
            if (ch === 13 || ch === 10) {
                result.push(value.substring(start, idx));
                idx++;
                while (idx < value.length && ((ch = value.charCodeAt(idx)) === 13 || ch === 10)) {
                    idx++;
                }
                start = idx;
            } else {
                idx++;
            }
        }
        this.remaining = start < value.length ? value.substr(start) : null;
        return result;
    }

    public end(): string {
        return this.remaining;
    }
}

enum RunTrigger {
    onSave,
    onType,
    never
}

namespace RunTrigger {
    'use strict';
    export let strings = {
        onSave: 'onSave',
        onType: 'onType',
        never: 'never'
    };
    export let from = function(value: string): RunTrigger {
        if (value === 'onSave') {
            return RunTrigger.onSave;
        } else if (value === 'onType') {
            return RunTrigger.onType;
        } else {
            return RunTrigger.never;
        }
    };
}

export default class HaskellLintingProvider implements vscode.CodeActionProvider {

    private static fileArgs: string[] = ['--json'];
    private static bufferArgs: string[] = ['-', '--json'];
    private  static hlintSuggestionPrefix: string = 'Hlint Suggestion: ';
    private  static hlintErrorPrefix: string = 'Hlint Error: ';

    private trigger: RunTrigger;
    private hintArgs: string[];
    private ignoreArgs: string[];
    private executable: string;
    private executableNotFound: boolean;
    private commandId: string;
    private command: vscode.Disposable;
    private documentListener: vscode.Disposable;
    private diagnosticCollection: vscode.DiagnosticCollection;
    private delayers: { [key: string]: ThrottledDelayer<void> };

    constructor() {
        this.executable = null;
        this.executableNotFound = false;
        this.hintArgs = [];
        this.ignoreArgs = [];
        this.commandId = 'haskell.runCodeAction';
        this.command = vscode.commands.registerCommand(this.commandId, this.runCodeAction, this);
    }

    public activate(subscriptions: vscode.Disposable[]): void {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
        subscriptions.push(this);
        vscode.workspace.onDidChangeConfiguration(this.loadConfiguration, this, subscriptions);
        this.loadConfiguration();

        vscode.workspace.onDidOpenTextDocument(this.triggerHlint, this, subscriptions);
        vscode.workspace.onDidCloseTextDocument((textDocument) => {
            this.diagnosticCollection.delete(textDocument.uri);
            delete this.delayers[textDocument.uri.toString()];
        }, null, subscriptions);

        // Hlint all open haskell documents
        vscode.workspace.textDocuments.forEach(this.triggerHlint, this);
    }

    public dispose(): void {
        this.diagnosticCollection.clear();
        this.diagnosticCollection.dispose();
        this.command.dispose();
    }

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range,
            context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.Command[] {
        return context.diagnostics.map((diagnostic) => {
            if (diagnostic.message.indexOf(HaskellLintingProvider.hlintSuggestionPrefix) === 0) {
                let match = /Replace with: (.*)/.exec(diagnostic.message);
                if (match[1]) {
                    return <vscode.Command>{
                        title: diagnostic.message.replace(HaskellLintingProvider.hlintSuggestionPrefix, ''),
                        command: this.commandId,
                        arguments: [match[1], document.uri, diagnostic.range, diagnostic.message]
                    };
                }
            } else {
                return null;
            }
        }).reverse();
    }

    private loadConfiguration(): void {
        let section = vscode.workspace.getConfiguration('haskell');
        let oldExecutable = this.executable;
        if (section) {
            this.executable = section.get<string>('hlint.executablePath', null);
            this.trigger = RunTrigger.from(section.get<string>('hlint.run', RunTrigger.strings.onType));
            this.hintArgs = section.get<string[]>('hlint.hints', []).map(arg => { return `--hint=${arg}`; });
            this.ignoreArgs = section.get<string[]>('hlint.ignore', []).map(arg => { return `--ignore=${arg}`; });
        }

        this.delayers = Object.create(null);
        if (this.executableNotFound) {
            this.executableNotFound = oldExecutable === this.executable;
        }
        if (this.documentListener) {
            this.documentListener.dispose();
        }
        if (this.trigger === RunTrigger.onType) {
            this.documentListener = vscode.workspace.onDidChangeTextDocument((e) => {
                this.triggerHlint(e.document);
            });
        } else if (this.trigger === RunTrigger.onSave) {
            this.documentListener = vscode.workspace.onDidSaveTextDocument(this.triggerHlint, this);
        }
        // Configuration has changed. Reevaluate all documents.
        vscode.workspace.textDocuments.forEach(this.triggerHlint, this);
    }

    private triggerHlint(textDocument: vscode.TextDocument): void {
        if (textDocument.languageId !== 'haskell' || this.executableNotFound) {
            return;
        }

        if (this.trigger === RunTrigger.never) {
            this.diagnosticCollection.set(textDocument.uri, null);
            return;
        }

        let key = textDocument.uri.toString();
        let delayer = this.delayers[key];
        if (!delayer) {
            delayer = new ThrottledDelayer<void>(this.trigger === RunTrigger.onType ? 250 : 0);
            this.delayers[key] = delayer;
        }
        delayer.trigger(() => this.doHlint(textDocument) );
    }

    private doHlint(textDocument: vscode.TextDocument): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let executable = this.executable || 'hlint';
            let decoder = new LineDecoder();
            let decoded = [];
            let diagnostics: vscode.Diagnostic[] = [];
            let processLine = (item: LintItem) => {
                if (item) {
                    diagnostics.push(HaskellLintingProvider._asDiagnostic(item));
                }
            };

            let options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } : undefined;
            let args: string[];
            if (this.trigger === RunTrigger.onSave) {
                args = HaskellLintingProvider.fileArgs.slice(0);
                args.push(textDocument.fileName);
            } else {
                args = HaskellLintingProvider.bufferArgs;
            }
            args = args.concat(this.hintArgs);
            args = args.concat(this.ignoreArgs);

            let childProcess = cp.spawn(executable, args, options);
            childProcess.on('error', (error: Error) => {
                if (this.executableNotFound) {
                    resolve();
                    return;
                }
                let message: string = null;
                if ((<any>error).code === 'ENOENT') {
                    message = `Cannot hlint the haskell file. The hlint program was not found. Use the 'haskell.hlint.executablePath' setting to configure the location of 'hlint'`;
                } else {
                    message = error.message ? error.message : `Failed to run hlint using path: ${executable}. Reason is unknown.`;
                }
                vscode.window.showInformationMessage(message);
                this.executableNotFound = true;
                resolve();
            });
            if (childProcess.pid) {
                if (this.trigger === RunTrigger.onType) {
                    childProcess.stdin.write(textDocument.getText());
                    childProcess.stdin.end();
                }
                childProcess.stdout.on('data', (data: Buffer) => {
                    decoded = decoded.concat(decoder.write(data));
                });
                childProcess.stdout.on('end', () => {
                    let output = decoded.concat(decoder.end()).join('');
                    if (output) {
                       JSON.parse(output).forEach(processLine);
                    }
                    this.diagnosticCollection.set(textDocument.uri, diagnostics);
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private runCodeAction(replacementText: string, uri: vscode.Uri, range: any): Thenable<boolean> {
        let edit = new vscode.WorkspaceEdit();
        let newRange = new vscode.Range(range.startLineNumber - 1, range.startColumn - 1, range.endLineNumber - 1, range.endColumn - 1);
        edit.replace(uri, newRange, replacementText);
        let ret: Thenable<boolean>;
        try {
            ret = vscode.workspace.applyEdit(edit);
        } catch (error) {
            console.log(error);
        }
        return ret;
    }

    private static _asDiagnostic(lintItem: LintItem): vscode.Diagnostic {
        let severity = this._asDiagnosticSeverity(lintItem.severity);
        let message: string;
        if (lintItem.hint.toLocaleLowerCase().indexOf('parse error') === -1 ) {
            message = this.hlintSuggestionPrefix + lintItem.hint + '. Replace with: ' + lintItem.to;
        } else {
            message = this.hlintErrorPrefix + lintItem.hint;
        }
        return new vscode.Diagnostic(this._getRange(lintItem), message, severity);
    }

    private static _asDiagnosticSeverity(logLevel: string): vscode.DiagnosticSeverity {
        switch (logLevel.toLowerCase()) {
            case 'warning':
                return vscode.DiagnosticSeverity.Warning;
            default:
                return vscode.DiagnosticSeverity.Error;
        }
    }

    private static _getRange(item: LintItem): vscode.Range {
        return new vscode.Range(item.startLine - 1, item.startColumn - 1, item.endLine - 1, item.endColumn - 1);
    }
}
