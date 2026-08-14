# CRI Container Attach

Attach a **new VS Code window** to CRI-based containers (containerd / CRI-O) running on a
Kubernetes node — like Dev Containers' "Attach to Running Container", but for plain CRI
runtimes reached through **Remote-SSH**.

The key property: it **reuses your existing Remote-SSH session** (including `ProxyJump`
setups and password auth). No extra credentials, no second login — the extension runs on
the node side of the window you already trust.

```
┌──────────┐   existing SSH (ProxyJump ok)   ┌───────────────────────┐
│  VS Code │ ──────────────────────────────► │  K8s node             │
│  (local) │      Remote-SSH tunnel          │  └─ crictl ──► containerd
└────┬─────┘                                 │      │                │
     │  new window:                          │      ▼                │
     │  cri-container+<port>-<token>-<name>  │  ┌─ pod netns ──────┐ │
     │  resolved to 127.0.0.1:<port>         │  │ vscode-server    │ │
     └──────────────────────────────────────►│  │ :4xxxx (token)   │ │
                                             │  └──────────────────┘ │
                                             └───────────────────────┘
```

## How it works

Two extensions, one codebase:

| Package | Runs where | Job |
|---|---|---|
| `cri-container-attach` (kind `workspace,ui`) | node side of the Remote-SSH window | container picker, install & start `vscode-server` inside the container, detect the pod IP, bridge it to node loopback, forward the port over the existing SSH connection |
| `cri-container-resolver` (kind `ui`) | UI side of every window | resolves `cri-container+…` authorities via the `resolvers` **proposed API** so the new window knows where to connect; labels windows with the container name |

Attach flow:

1. `crictl ps` → pick a container.
2. Match the node's VS Code commit, install the matching `vscode-server` into the
   container (`~/.vscode-server` inside it), start it on a random port in `40000-49999`
   with a random connection token, bound to `0.0.0.0`.
3. Resolve the container/pod IP (container inspect → pod sandbox inspect → `hostname -i`
   fallback; host-networked containers fall back to `127.0.0.1`).
4. If the target is not loopback, a relay on the node's `127.0.0.1` bridges to the pod IP,
   then `vscode.env.asExternalUri` forwards it over Remote-SSH to your machine.
5. Open `vscode-remote://cri-container+<localPort>-<token>-<containerName-hex>/` in a new
   window; the resolver extension connects it to the container's server.

No passwords are ever handled by the extension — everything rides the SSH connection that
Remote-SSH already maintains.

## Install

Prerequisites:

- VS Code ≥ 1.85 with the **Remote-SSH** extension, connected to the node
- `crictl` on the node with access to the runtime socket
- `sh`, `tar`, and `curl` or `wget` inside the target container (first install only)

Steps:

1. Build the two VSIX packages (see below) — or grab them from releases.
2. In the **Remote-SSH window**: *Extensions → Install from VSIX* →
   `cri-container-attach-<version>.vsix` (install in the SSH remote).
3. In the same window: install `cri-container-resolver-<version>.vsix` — it must land
   **locally** (it is UI-only, VS Code installs it on the desktop automatically; verify
   with `ls ~/.vscode/extensions | grep cri-container-resolver`).
4. On first activation the extension whitelists itself for the `resolvers` proposed API by
   patching VS Code's `product.json` (`extensionEnabledApiProposals`). **Fully quit VS
   Code (Cmd+Q / exit) and relaunch once** — this is read only at startup.
5. Run **CRI Container: Attach**, pick a container, and a new window opens attached to it.
   Keep the Remote-SSH window open while using the container window — the tunnel and relay
   live there.

## Usage

Commands (in the Remote-SSH window, palette `CRI Container`):

- **Attach to CRI Container** — pick a container and open a new attached window
- **List CRI Containers** — quick view of containers with pod/namespace
- **Exec into CRI Container (Terminal)** — interactive shell via `crictl exec`

Configuration (`settings.json`):

| Setting | Default | Description |
|---|---|---|
| `cri-container.crictlPath` | `crictl` | crictl binary path on the node |
| `cri-container.runtimeEndpoint` | `unix:///run/containerd/containerd.sock` | CRI runtime socket |
| `cri-container.defaultShell` | `/bin/sh` | shell for *Exec into Container* |
| `cri-container.serverInstallPath` | `/root/.vscode-server` | server install base inside containers |

## Building the VSIX packages

```bash
npm install
npm run compile
npx @vscode/vsce package   # then rename/package twice for the resolver variant,
                           # or use the two-extension packaging script
```

The two packages differ only in `name`, `displayName`, and `extensionKind`
(`workspace,ui` vs `ui`) — `src/` is shared. `src/proposedApi.d.ts` declares the small
slice of the `resolvers` proposed API that is used.

## Known limitations

- Only containers on the node you are SSH'd into (that is where `crictl` runs).
- Requires the `resolvers` proposed API, enabled via the `product.json` patch — if a VS
  Code update replaces `product.json`, re-run attach once and restart to re-patch.
- The attached window's tunnel depends on the originating Remote-SSH window staying open.
- Stale servers from previous attach runs inside a container are killed automatically on
  the next attach to that container.

## License

Provided as-is for internal tooling; no warranty.
