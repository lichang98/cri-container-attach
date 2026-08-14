import * as vscode from 'vscode';
import * as net from 'net';
import { Logger } from './logger';

function tcpConnectable(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(timeoutMs);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('timeout', () => { s.destroy(); resolve(false); });
        s.on('error', () => { s.destroy(); resolve(false); });
        s.connect(port, '127.0.0.1');
    });
}

// Authority format: cri-container+<localPort>-<token>[-<hex container name>]
export function containerNameFromAuthority(authority: string): string {
    const m = authority.match(/^cri-container\+\d+-[0-9a-f]{32}-([0-9a-f]+)$/);
    if (!m) { return ''; }
    try {
        return Buffer.from(m[1], 'hex').toString('utf8') || '';
    } catch { return ''; }
}

export class CriContainerResolver implements vscode.RemoteAuthorityResolver {
    constructor(private logger: Logger) {}

    getLabel(_authorityPrefix: string): string {
        return 'CRI Container';
    }

    async resolve(authority: string): Promise<vscode.ResolverResult> {
        this.logger.info(`Resolving authority: ${authority}`);

        const m = authority.match(/^cri-container\+(\d+)-([0-9a-f]{32})(?:-[0-9a-f]+)?$/);
        if (!m) {
            throw new Error(`Unrecognized container authority "${authority}". Re-run "CRI Container: Attach".`);
        }
        const localPort = Number(m[1]);
        const token = m[2];

        if (!await tcpConnectable(localPort)) {
            throw new Error(
                `Container tunnel 127.0.0.1:${localPort} is not reachable. ` +
                `Keep the original Remote-SSH window open, or re-run "CRI Container: Attach".`,
            );
        }

        this.logger.info(`Resolved: 127.0.0.1:${localPort}`);
        return new vscode.ResolvedAuthority('127.0.0.1', localPort, token);
    }
}
