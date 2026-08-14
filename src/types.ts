export interface ContainerInfo {
    id: string;
    name: string;
    image: string;
    state: string;
    podName: string;
    podNamespace: string;
}

export interface CrictlConfig {
    crictlPath: string;
    runtimeEndpoint: string;
    defaultShell: string;
    serverInstallPath: string;
}
