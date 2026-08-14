import * as vscode from 'vscode';
import * as net from 'net';
import { Logger } from './logger';

const relays: net.Server[] = [];

export function closeRelays(): void {
    for (const s of relays.splice(0)) {
        try { s.close(); } catch { /* ignore */ }
    }
}

function startRelay(targetHost: string, targetPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer((client) => {
            const upstream = net.connect(targetPort, targetHost);
            client.pipe(upstream).pipe(client);
            client.on('error', () => upstream.destroy());
            upstream.on('error', () => client.destroy());
        });
        server.listen(0, '127.0.0.1', () => {
            relays.push(server);
            resolve((server.address() as net.AddressInfo).port);
        });
        server.on('error', reject);
    });
}

function tcpConnectableOnNode(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(timeoutMs);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('timeout', () => { s.destroy(); resolve(false); });
        s.on('error', () => { s.destroy(); resolve(false); });
        s.connect(port, host);
    });
}

function localEndpoint(uri: vscode.Uri): number | null {
    const m = uri.authority.match(/^(?:127\.0\.0\.1|localhost):(\d+)$/);
    return m ? Number(m[1]) : null;
}

// Maps an address reachable from the node to a local 127.0.0.1 port over the
// existing Remote-SSH connection. No SSH credentials needed: VS Code tunnels
// through the session this window already uses. This code runs on the node
// (workspace side), so reachability checks and the relay happen there.
export async function forwardRemotePort(targetHost: string, targetPort: number, logger: Logger): Promise<number> {
    // Fail fast with a clear message instead of a hung window in the new VS Code instance
    if (!(await tcpConnectableOnNode(targetHost, targetPort, 5000))) {
        throw new Error(
            `node cannot reach ${targetHost}:${targetPort} — the container address could not be determined ` +
            `(pod-networked container?). Check "Container target:" in this log.`,
        );
    }

    let forwardPort = targetPort;
    if (!/^(127\.|localhost(?::|$))/.test(targetHost)) {
        // VS Code tunnels only forward to remote loopback; bridge pod IP -> node loopback
        forwardPort = await startRelay(targetHost, targetPort);
        logger.info(`Relay on node 127.0.0.1:${forwardPort} -> ${targetHost}:${targetPort}`);
    }

    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${forwardPort}`));
    logger.info(`asExternalUri(http://127.0.0.1:${forwardPort}) -> ${uri.toString()}`);
    const localPort = localEndpoint(uri);
    if (!localPort) {
        throw new Error('Port forwarding through Remote-SSH failed');
    }
    return localPort;
}
