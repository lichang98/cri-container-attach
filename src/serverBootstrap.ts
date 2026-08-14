import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CrictlConfig } from './types';
import { CriClient } from './criClient';
import { Logger } from './logger';

export class ServerBootstrap {
    constructor(
        private config: CrictlConfig,
        private logger: Logger,
    ) {}

    async getVscodeCommitHash(): Promise<string> {
        // The extension host runs inside vscode-server on the node:
        // ~/.vscode-server/cli/servers/Stable-<commit>/server/node
        const m = process.execPath.match(/servers\/[^/]*-([0-9a-f]{40})\//);
        if (m) {
            this.logger.info(`VS Code commit hash (from execPath): ${m[1]}`);
            return m[1];
        }
        const serversDir = path.join(os.homedir(), '.vscode-server', 'cli', 'servers');
        try {
            for (const entry of fs.readdirSync(serversDir)) {
                const mm = entry.match(/-([0-9a-f]{40})$/);
                if (mm) {
                    this.logger.info(`VS Code commit hash (from servers dir): ${mm[1]}`);
                    return mm[1];
                }
            }
        } catch { /* fall through */ }
        throw new Error('Could not determine VS Code commit hash on this machine');
    }

    async ensureServerInstalled(criClient: CriClient, containerId: string, commitHash: string): Promise<void> {
        const binDir = `${this.config.serverInstallPath}/bin/${commitHash}`;

        try {
            await criClient.execInContainer(containerId, `test -f ${binDir}/node`);
            this.logger.info(`vscode-server ${commitHash} already installed in container`);
            return;
        } catch { /* not installed */ }

        this.logger.info('Installing vscode-server inside container...');
        const url = `https://update.code.visualstudio.com/commit:${commitHash}/server-linux-x64/stable`;

        await criClient.execInContainer(containerId,
            `mkdir -p ${binDir} && cd ${binDir} && ` +
            `(curl -fsSL '${url}' -o s.tgz 2>/dev/null || wget -q '${url}' -O s.tgz 2>/dev/null) && ` +
            `tar xzf s.tgz --strip-components=1 && rm -f s.tgz`,
            180000,
        );

        this.logger.info('vscode-server installed successfully');
    }

    async startServer(
        criClient: CriClient,
        containerId: string,
        commitHash: string,
        token: string,
    ): Promise<{ port: number; pid: number }> {
        const binDir = `${this.config.serverInstallPath}/bin/${commitHash}`;

        let serverBinary = `${binDir}/bin/code-server`;
        try {
            await criClient.execInContainer(containerId, `test -f ${serverBinary}`);
        } catch {
            serverBinary = `${binDir}/bin/vscode-server`;
        }
        this.logger.info(`Using server binary: ${serverBinary}`);

        const port = 40000 + Math.floor(Math.random() * 10000);

        // Stop servers left behind by earlier attach runs (each one binds a port forever)
        await criClient.execInContainer(containerId,
            `pkill -f -- '--start-server --host=0.0.0.0' >/dev/null 2>&1 || true`, 15000,
        ).catch(() => undefined);

        const pidOut = await criClient.execInContainer(containerId,
            `nohup ${serverBinary} --start-server --host=0.0.0.0 --port=${port} ` +
            `--connection-token=${token} --accept-server-license-terms ` +
            `> /tmp/vscode-server-${port}.log 2>&1 & echo $!`,
        );
        const pid = parseInt(pidOut.trim(), 10);

        const probe =
            `${binDir}/node -e "require('http').get('http://127.0.0.1:${port}/?tkn=${token}',` +
            `r=>{console.log('HTTP'+r.statusCode);r.resume()}).on('error',e=>console.log('ERR '+e.message))"`;

        const deadline = Date.now() + 30000;
        let ready = false;
        let lastProbe = '';
        while (Date.now() < deadline) {
            try {
                const out = await criClient.execInContainer(containerId, probe, 10000);
                lastProbe = out.trim();
                const m = lastProbe.match(/HTTP(\d+)/);
                // Any HTTP answer (even 404 on "/") proves the server is up and token-checked
                if (m && Number(m[1]) < 500) {
                    ready = true;
                    break;
                }
            } catch (e) {
                lastProbe = (e as Error).message;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        this.logger.info(`Readiness probe result: ${lastProbe}`);

        if (!ready) {
            const log = await criClient.execInContainer(containerId, `tail -20 /tmp/vscode-server-${port}.log`, 10000).catch(() => '');
            if (log.includes(`listening on ${port}`)) {
                this.logger.warn('HTTP probe failed but server log reports it is listening; continuing');
                ready = true;
            } else {
                this.logger.warn(`Server log: ${log}`);
                throw new Error(`vscode-server did not become ready on port ${port}`);
            }
        }

        this.logger.info(`vscode-server ready on port ${port}, PID ${pid}`);
        return { port, pid };
    }
}
