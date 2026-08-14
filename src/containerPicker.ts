import * as vscode from 'vscode';
import { ContainerInfo } from './types';
import { CriClient } from './criClient';

export async function pickContainer(criClient: CriClient): Promise<ContainerInfo | undefined> {
    const containers = await criClient.listContainers();
    const running = containers.filter(c => c.state === 'CONTAINER_RUNNING');

    if (running.length === 0) {
        vscode.window.showInformationMessage('No running containers found.');
        return undefined;
    }

    const items = running.map(c => ({
        label: c.name || c.id.substring(0, 12),
        description: `${c.podNamespace}/${c.podName}`,
        detail: `Image: ${c.image}`,
        container: c,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a container to attach',
    });

    return selected?.container;
}
