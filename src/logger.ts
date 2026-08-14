import * as vscode from 'vscode';

export class Logger {
    private channel: vscode.OutputChannel;

    constructor(name: string) {
        this.channel = vscode.window.createOutputChannel(name);
    }

    info(msg: string): void {
        this.log('INFO', msg);
    }

    warn(msg: string): void {
        this.log('WARN', msg);
    }

    error(msg: string): void {
        this.log('ERROR', msg);
    }

    show(): void {
        this.channel.show(true);
    }

    dispose(): void {
        this.channel.dispose();
    }

    private log(level: string, msg: string): void {
        const ts = new Date().toISOString();
        this.channel.appendLine(`[${level}] ${ts} ${msg}`);
    }
}
