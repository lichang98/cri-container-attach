import { CrictlConfig } from './types';
import * as vscode from 'vscode';

export function loadConfig(): CrictlConfig {
    const cfg = vscode.workspace.getConfiguration('cri-container');
    return {
        crictlPath: cfg.get<string>('crictlPath', 'crictl'),
        runtimeEndpoint: cfg.get<string>('runtimeEndpoint', 'unix:///run/containerd/containerd.sock'),
        defaultShell: cfg.get<string>('defaultShell', '/bin/sh'),
        serverInstallPath: cfg.get<string>('serverInstallPath', '/root/.vscode-server'),
    };
}
