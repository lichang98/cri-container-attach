import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from './config';
import { Logger } from './logger';
import { CriClient } from './criClient';
import { ServerBootstrap } from './serverBootstrap';
import { pickContainer } from './containerPicker';
import { CriContainerResolver, containerNameFromAuthority } from './resolver';
import { forwardRemotePort, closeRelays } from './forwarder';

let logger: Logger;

function q(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function logWhitelistState(log: Logger): void {
    const candidates = [
        '/Applications/Visual Studio Code.app/Contents/Resources/app/product.json',
        path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/product.json'),
        '/usr/share/code/resources/app/product.json',
        '/usr/lib/code/resources/app/product.json',
        '/opt/visual-studio-code/resources/app/product.json',
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p)) { continue; }
        try {
            const product = JSON.parse(fs.readFileSync(p, 'utf8'));
            const proposals = product.extensionEnabledApiProposals || {};
            const attach = (proposals['local.cri-container-attach'] || []).includes('resolvers');
            const resolver = (proposals['local.cri-container-resolver'] || []).includes('resolvers');
            log.info(`Whitelist in ${p}: attach=${attach} resolver=${resolver}`);
        } catch (e) {
            log.warn(`Failed to read ${p}: ${(e as Error).message}`);
        }
    }
}

function patchLocalProductJson(log: Logger): number {
    const candidates = [
        '/Applications/Visual Studio Code.app/Contents/Resources/app/product.json',
        path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/product.json'),
        '/usr/share/code/resources/app/product.json',
        '/usr/lib/code/resources/app/product.json',
        '/opt/visual-studio-code/resources/app/product.json',
    ];
    const ids = ['local.cri-container-attach', 'local.cri-container-resolver'];

    let patched = 0;
    for (const p of candidates) {
        if (!fs.existsSync(p)) { continue; }
        try {
            const product = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!product.extensionEnabledApiProposals) {
                product.extensionEnabledApiProposals = {};
            }
            let dirty = false;
            for (const id of ids) {
                const existing = product.extensionEnabledApiProposals[id];
                if (!existing || !existing.includes('resolvers')) {
                    product.extensionEnabledApiProposals[id] = ['resolvers'];
                    dirty = true;
                }
            }
            if (dirty) {
                fs.writeFileSync(p, JSON.stringify(product, null, '\t'));
                log.info(`Patched: ${p}`);
            } else {
                log.info(`Already patched: ${p}`);
            }
            patched++;
        } catch (e) {
            log.warn(`Failed to patch ${p}: ${(e as Error).message}`);
        }
    }
    return patched;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // vscode.env.remoteName reflects the WINDOW, not where this extension runs:
    // a UI-kind extension inside an ssh-remote window also sees remoteName='ssh-remote'.
    // extensionKind is the only reliable way to tell UI side from workspace side.
    const isUiSide = context.extension.extensionKind === vscode.ExtensionKind.UI;
    const remoteName = vscode.env.remoteName;
    logger = new Logger(isUiSide ? 'CRI Container Attach (local)' : 'CRI Container Attach');
    logger.info(`=== CRI Container Attach v0.12.1 activating (id=${context.extension.id}, kind=${isUiSide ? 'UI' : 'workspace'}, remoteName=${remoteName || 'local'}) ===`);

    if (isUiSide) {
        // UI side of any window (local, Remote-SSH, or the cri-container window):
        // patch product.json and register the authority resolver. In the new
        // cri-container window ONLY UI extensions run before the connection is
        // established, so this registration is what resolves the authority.
        logWhitelistState(logger);
        const patched = patchLocalProductJson(logger);
        logger.info(`product.json patch result: ${patched}`);

        let registered = false;
        const registerFn = (vscode.workspace as any).registerRemoteAuthorityResolver;
        if (typeof registerFn === 'function') {
            try {
                context.subscriptions.push(registerFn('cri-container', new CriContainerResolver(logger)));
                registered = true;
                logger.info('Resolver registered successfully');
            } catch (e) {
                logger.warn(`Resolver registration failed: ${(e as Error).message}`);
            }
        } else {
            logger.warn('registerRemoteAuthorityResolver not available');
        }

        if (!registered) {
            vscode.window.showWarningMessage(
                'CRI Container Attach: the "resolvers" API is not enabled yet. ' +
                (patched > 0
                    ? 'Fully quit VS Code (Cmd+Q) and relaunch, then attach again.'
                    : 'Could not patch product.json automatically — see the "CRI Container Attach (local)" output channel.'),
            );
        }

        // Give container windows a proper label (remote indicator / window title)
        // instead of the generic "vscode-remote"
        if (vscode.env.remoteName === 'cri-container') {
            const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority || '';
            const name = containerNameFromAuthority(authority) || 'CRI Container';
            logger.info(`Registering label formatter for container: ${name}`);
            context.subscriptions.push(vscode.workspace.registerResourceLabelFormatter({
                scheme: 'vscode-remote',
                formatting: { label: '${path}', separator: '/', workspaceSuffix: name },
            }));
        }
        return;
    }

    if (remoteName !== 'ssh-remote') {
        // Workspace side inside an attached container window: nothing to do
        logger.info('Running inside attached container; staying idle');
        return;
    }

    // Node side of a Remote-SSH window: crictl runs directly here and port
    // forwarding rides this window's existing SSH connection — no re-authentication.
    context.subscriptions.push(
        vscode.commands.registerCommand('cri-container.attach', async () => {
            try {
                const config = loadConfig();
                const criClient = new CriClient(config, logger);
                const container = await pickContainer(criClient);
                if (!container) { return; }

                const bootstrap = new ServerBootstrap(config, logger);

                const commitHash = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Detecting VS Code version...', cancellable: false },
                    () => bootstrap.getVscodeCommitHash(),
                );

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Installing VS Code Server in container...', cancellable: false },
                    () => bootstrap.ensureServerInstalled(criClient, container.id, commitHash),
                );

                const token = crypto.randomBytes(16).toString('hex');
                const { port } = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Starting VS Code Server...', cancellable: false },
                    () => bootstrap.startServer(criClient, container.id, commitHash, token),
                );

                const ip = await criClient.getContainerIp(container.id).catch(() => '');
                const targetHost = ip || '127.0.0.1';
                logger.info(`Container target: ${targetHost}:${port}`);

                const localPort = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Forwarding port over Remote-SSH...', cancellable: false },
                    () => forwardRemotePort(targetHost, port, logger),
                );
                logger.info(`Forwarded: 127.0.0.1:${localPort} -> ${targetHost}:${port}`);

                // Container name rides along (hex-encoded) so container windows can
                // label themselves instead of showing the generic "vscode-remote"
                const nameHex = Buffer.from(container.name || 'container', 'utf8').toString('hex');
                const authority = `cri-container+${localPort}-${token}-${nameHex}`;
                const uri = vscode.Uri.parse(`vscode-remote://${authority}/`);
                try {
                    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
                    logger.info('New window opening for container workspace');
                    vscode.window.showInformationMessage(
                        `Attached to ${container.name} — new window opening. Keep this window open while using it.`,
                    );
                } catch (e) {
                    logger.warn(`openFolder failed: ${(e as Error).message}; falling back to browser`);
                    const webUrl = `http://127.0.0.1:${localPort}/?tkn=${token}`;
                    await vscode.env.openExternal(vscode.Uri.parse(webUrl));
                    vscode.window.showInformationMessage(`Container workspace ready for ${container.name}: ${webUrl}`);
                }
            } catch (err) {
                const message = (err as Error).message;
                vscode.window.showErrorMessage(`CRI attach failed: ${message}`);
                logger.error(`Attach failed: ${message}`);
                logger.show();
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cri-container.listContainers', async () => {
            try {
                const criClient = new CriClient(loadConfig(), logger);
                const containers = await criClient.listContainers();
                const items = containers.map((c) => ({
                    label: c.name || c.id.substring(0, 12),
                    description: `${c.podNamespace}/${c.podName}`,
                    detail: `State: ${c.state}`,
                }));
                await vscode.window.showQuickPick(items, { placeHolder: 'CRI Containers' });
            } catch (err) {
                vscode.window.showErrorMessage(`Failed: ${(err as Error).message}`);
                logger.show();
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cri-container.execInto', async () => {
            try {
                const config = loadConfig();
                const criClient = new CriClient(config, logger);
                const container = await pickContainer(criClient);
                if (!container) { return; }

                // Terminals in a Remote-SSH window run on the node — exec directly via crictl
                const cmd = `exec ${q(config.crictlPath)} --runtime-endpoint=${q(config.runtimeEndpoint)} exec -it ${q(container.id)} ${q(config.defaultShell)}`;
                const term = vscode.window.createTerminal({
                    name: `CRI: ${container.name}`,
                    shellPath: '/bin/sh',
                    shellArgs: ['-c', cmd],
                });
                term.show();
            } catch (err) {
                vscode.window.showErrorMessage(`Exec failed: ${(err as Error).message}`);
                logger.error(`execInto failed: ${(err as Error).message}`);
            }
        }),
    );

    logger.info('CRI Container Attach extension activated (node side)');
}

export function deactivate(): void {
    closeRelays();
    logger?.info('Deactivating CRI Container Attach extension');
    logger?.dispose();
}
