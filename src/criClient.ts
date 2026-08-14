import { spawn } from 'child_process';
import { ContainerInfo, CrictlConfig } from './types';
import { Logger } from './logger';

// Runs crictl directly — this extension activates on the node itself (workspace side of Remote-SSH)
export class CriClient {
    constructor(private config: CrictlConfig, private logger: Logger) {}

    private run(args: string[], timeoutMs = 60000): Promise<string> {
        const full = [`--runtime-endpoint=${this.config.runtimeEndpoint}`, ...args];
        this.logger.info(`crictl ${full.join(' ').substring(0, 200)}`);
        return new Promise((resolve, reject) => {
            const proc = spawn(this.config.crictlPath, full, { stdio: ['ignore', 'pipe', 'pipe'] });

            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
            proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

            const timer = setTimeout(() => {
                proc.kill();
                reject(new Error(`crictl timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            proc.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(stderr.trim() || `crictl exit code ${code}`));
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    async listContainers(): Promise<ContainerInfo[]> {
        const output = await this.run(['ps', '-a', '-o', 'json']);
        const data = JSON.parse(output);
        const containers: ContainerInfo[] = [];

        for (const c of data.containers || []) {
            containers.push({
                id: c.id,
                name: c.metadata?.name || '',
                image: c.image?.image || '',
                state: c.state || '',
                podName: c.labels?.['io.kubernetes.pod.name'] || '',
                podNamespace: c.labels?.['io.kubernetes.pod.namespace'] || '',
            });
        }
        return containers;
    }

    async inspectContainer(id: string): Promise<any> {
        const output = await this.run(['inspect', id]);
        return JSON.parse(output);
    }

    async getContainerIp(id: string): Promise<string> {
        const inspect = await this.inspectContainer(id);
        const direct = inspect?.status?.ip || inspect?.info?.ip;
        if (direct) { return String(direct); }

        // Container inspect carries no IP on many CRI versions: ask the pod sandbox
        const podName = inspect?.status?.labels?.['io.kubernetes.pod.name'];
        const podNs = inspect?.status?.labels?.['io.kubernetes.pod.namespace'] || 'default';
        if (podName) {
            try {
                const podsOut = await this.run(['pods', '--name', podName, '--namespace', podNs, '-o', 'json']);
                const podId = JSON.parse(podsOut)?.items?.[0]?.id;
                if (podId) {
                    const pod = JSON.parse(await this.run(['inspectp', podId]));
                    const ip = pod?.status?.ip;
                    if (ip) { return String(ip); }
                }
            } catch (e) {
                this.logger.warn(`Pod IP lookup failed: ${(e as Error).message}`);
            }
        }

        // Last resort: ask the container itself
        try {
            const out = await this.execInContainer(id, 'hostname -i 2>/dev/null || true', 15000);
            const m = out.trim().match(/(\d{1,3}(?:\.\d{1,3}){3})/);
            if (m) { return m[1]; }
        } catch (e) {
            this.logger.warn(`hostname -i failed: ${(e as Error).message}`);
        }

        return '';
    }

    async execInContainer(id: string, command: string, timeoutMs = 60000): Promise<string> {
        return this.run(['exec', id, 'sh', '-c', command], timeoutMs);
    }
}
