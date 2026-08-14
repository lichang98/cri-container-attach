declare module 'vscode' {
    export class ResolvedAuthority {
        readonly host: string;
        readonly port: number;
        readonly connectionToken?: string;
        constructor(host: string, port: number, connectionToken?: string);
    }

    export interface ManagedMessagePassing {
        readonly onDidReceiveMessage: Event<Uint8Array>;
        readonly onDidClose: Event<Error | undefined>;
        readonly onDidEnd: Event<void>;
        send: (data: Uint8Array) => void;
        end: () => void;
        drain?: () => Thenable<void>;
    }

    export class ManagedResolvedAuthority {
        readonly makeConnection: () => Thenable<ManagedMessagePassing>;
        readonly connectionToken: string | undefined;
        constructor(makeConnection: () => Thenable<ManagedMessagePassing>, connectionToken?: string);
    }

    export type ResolverResult = ResolvedAuthority | ManagedResolvedAuthority;

    export interface RemoteAuthorityResolverContext {
        resolveAttempt: number;
    }

    export interface RemoteAuthorityResolver {
        resolve(authority: string, context?: RemoteAuthorityResolverContext): ResolverResult | Thenable<ResolverResult>;
    }

    export interface ResourceLabelFormatting {
        label: string;
        separator?: string;
        tildify?: boolean;
        normalizeDriveLetter?: boolean;
        workspaceSuffix?: string;
        authorityPrefix?: string;
        stripPathStartingSeparator?: boolean;
    }

    export interface ResourceLabelFormatter {
        scheme: string;
        authority?: string;
        formatting: ResourceLabelFormatting;
    }

    export namespace workspace {
        export function registerRemoteAuthorityResolver(
            authorityPrefix: string,
            resolver: RemoteAuthorityResolver,
        ): Disposable;

        export function registerResourceLabelFormatter(formatter: ResourceLabelFormatter): Disposable;
    }
}
