import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './logger';

// Authority format (all fields after the token are lowercase/URI-safe; strings hex-encoded):
//   cri-container+<token>-<serverPort>-<localPort>-<sshTarget>-<targetHost>-<containerName>
// localPort is the legacy forwarded port (0 when unavailable): it is only used as a
// fallback for VS Code builds without ManagedResolvedAuthority.
export interface ContainerAuthority {
    token: string;
    serverPort: number;
    localPort: number;
    sshTarget: string;
    targetHost: string;
    containerName: string;
}

export function parseAuthority(authority: string): ContainerAuthority | null {
    const m = authority.match(/^cri-container\+([0-9a-f]{32})-(\d+)-(\d+)-([0-9a-f]+)-([0-9a-f]+)-([0-9a-f]+)$/);
    if (!m) { return null; }
    const hex = (h: string) => Buffer.from(h, 'hex').toString('utf8');
    return {
        token: m[1],
        serverPort: Number(m[2]),
        localPort: Number(m[3]),
        sshTarget: hex(m[4]),
        targetHost: hex(m[5]),
        containerName: hex(m[6]),
    };
}

export function containerNameFromAuthority(authority: string): string {
    return parseAuthority(authority)?.containerName || '';
}

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

// ---- ssh connection ownership --------------------------------------------------
// The attached window dials the container itself via `ssh -W`, so it no longer
// depends on the Remote-SSH window that started the attach. Auth strategy:
// passwordless first (keys / ControlMaster), then a single password prompt per
// window delivered to ssh through SSH_ASKPASS.

type AuthMode = { mode: 'passwordless' } | { mode: 'password'; password: string };
const authCache = new Map<string, AuthMode>();

function baseSshArgs(targetHost: string, serverPort: number, sshTarget: string): string[] {
    return [
        '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=15',
        '-W', `${targetHost}:${serverPort}`,
        sshTarget,
    ];
}

function probePasswordless(targetHost: string, serverPort: number, sshTarget: string, logger: Logger): Promise<'ok' | 'denied' | 'error'> {
    return new Promise((resolve) => {
        let stderr = '';
        let settled = false;
        let proc: ReturnType<typeof spawn>;
        const done = (r: 'ok' | 'denied' | 'error') => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            try { proc.kill(); } catch { /* ignore */ }
            resolve(r);
        };
        const timer = setTimeout(() => done('ok'), 2500);
        proc = spawn('ssh', ['-o', 'BatchMode=yes', ...baseSshArgs(targetHost, serverPort, sshTarget)], { stdio: ['ignore', 'ignore', 'pipe'] });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('error', (e) => { logger.warn(`ssh probe error: ${e.message}`); done('error'); });
        proc.on('close', (code) => {
            if (/permission denied|authenticat/i.test(stderr)) {
                done('denied');
            } else {
                logger.warn(`ssh probe failed (exit ${code}): ${stderr.trim().split('\n').slice(-2).join(' | ')}`);
                done('error');
            }
        });
        // A probe still alive after the timeout has authenticated and is forwarding
    });
}

function writeAskpass(password: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-askpass-'));
    const file = path.join(dir, 'askpass.sh');
    const safe = password.replace(/'/g, `'\\''`);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${safe}'\n`, { mode: 0o700 });
    return file;
}

function sshMessagePassing(a: ContainerAuthority, logger: Logger): Promise<vscode.ManagedMessagePassing> {
    return new Promise((resolve) => {
        const auth = authCache.get(a.sshTarget);
        const args = baseSshArgs(a.targetHost, a.serverPort, a.sshTarget);
        const env = { ...process.env };
        let askpass: string | undefined;
        if (auth?.mode === 'password') {
            askpass = writeAskpass(auth.password);
            env.SSH_ASKPASS = askpass;
            env.SSH_ASKPASS_REQUIRE = 'force';
            env.DISPLAY = env.DISPLAY || ':0';
        } else {
            args.unshift('-o', 'BatchMode=yes');
        }

        const cleanup = () => {
            if (askpass) {
                try { fs.rmSync(path.dirname(askpass), { recursive: true, force: true }); } catch { /* ignore */ }
                askpass = undefined;
            }
        };

        const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
        const received = new vscode.EventEmitter<Uint8Array>();
        const closed = new vscode.EventEmitter<Error | undefined>();
        const ended = new vscode.EventEmitter<void>();
        let stderr = '';

        child.on('error', (e) => {
            cleanup();
            closed.fire(e);
            ended.fire();
        });
        child.stderr?.on('data', (d: Buffer) => {
            const line = d.toString().trim();
            if (line) { stderr += line + '\n'; logger.info(`ssh: ${line}`); }
        });
        child.on('close', (code) => {
            cleanup();
            if (/permission denied/i.test(stderr)) {
                // Cached password went stale: drop it so the next resolve re-prompts
                authCache.delete(a.sshTarget);
            }
            closed.fire(code === null ? new Error(`ssh exited (${stderr.trim()})`) : undefined);
            ended.fire();
        });

        child.stdout?.on('data', (d: Buffer) => {
            received.fire(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
        });

        resolve({
            onDidReceiveMessage: received.event,
            onDidClose: closed.event,
            onDidEnd: ended.event,
            send: (data) => { child.stdin?.write(Buffer.from(data)); },
            end: () => {
                try { child.kill(); } catch { /* ignore */ }
            },
        });
    });
}

async function ensureAuth(a: ContainerAuthority, logger: Logger): Promise<'ready' | 'cancel'> {
    if (authCache.has(a.sshTarget)) { return 'ready'; }

    const probe = await probePasswordless(a.targetHost, a.serverPort, a.sshTarget, logger);
    if (probe === 'ok') {
        authCache.set(a.sshTarget, { mode: 'passwordless' });
        logger.info(`ssh to ${a.sshTarget}: passwordless (key or ControlMaster)`);
        return 'ready';
    }
    if (probe === 'error') {
        if (a.localPort === 0) {
            // Nothing to fall back to: let the real connection surface the error
            authCache.set(a.sshTarget, { mode: 'passwordless' });
            return 'ready';
        }
        // Unusable target (unknown host, no route...): prefer the forwarded-port fallback
        return 'cancel';
    }

    const password = await vscode.window.showInputBox({
        password: true,
        prompt: `SSH password for ${a.sshTarget} — used only for this container window's connection`,
        ignoreFocusOut: true,
    });
    if (!password) { return 'cancel'; }
    authCache.set(a.sshTarget, { mode: 'password', password });
    return 'ready';
}

export class CriContainerResolver implements vscode.RemoteAuthorityResolver {
    constructor(private logger: Logger) {}

    async resolve(authority: string): Promise<vscode.ResolverResult> {
        this.logger.info(`Resolving authority: ${authority}`);
        const parsed = parseAuthority(authority);
        if (!parsed) {
            throw new Error(`Unrecognized container authority "${authority}". Re-run "CRI Container: Attach".`);
        }

        const managedCtor = (vscode as any).ManagedResolvedAuthority;
        if (typeof managedCtor !== 'function') {
            this.logger.warn('ManagedResolvedAuthority unavailable; using forwarded-port fallback');
            return this.legacyForwarded(parsed);
        }

        if (await ensureAuth(parsed, this.logger) === 'cancel') {
            return this.legacyForwarded(parsed);
        }

        this.logger.info(`Connecting via ssh -W ${parsed.targetHost}:${parsed.serverPort} ${parsed.sshTarget}`);
        return new managedCtor(() => sshMessagePassing(parsed, this.logger), parsed.token) as vscode.ResolverResult;
    }

    private async legacyForwarded(parsed: ContainerAuthority): Promise<vscode.ResolvedAuthority> {
        if (parsed.localPort > 0 && await tcpConnectable(parsed.localPort)) {
            this.logger.info(`Fallback: resolved via forwarded port 127.0.0.1:${parsed.localPort}`);
            return new vscode.ResolvedAuthority('127.0.0.1', parsed.localPort, parsed.token);
        }
        throw new Error(
            'Could not establish an independent SSH connection to the node and no forwarded port is available. ' +
            'Keep the original Remote-SSH window open and re-attach, or configure SSH key auth for the node.',
        );
    }
}
