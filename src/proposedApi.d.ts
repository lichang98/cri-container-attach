declare module 'vscode' {
    export class ResolvedAuthority {
        readonly host: string;
        readonly port: number;
        readonly connectionToken?: string;
        constructor(host: string, port: number, connectionToken?: string);
    }

    export type ResolverResult = ResolvedAuthority;

    export interface RemoteAuthorityResolver {
        resolve(authority: string): ResolverResult | Thenable<ResolverResult>;
        getLabel?(authorityPrefix: string): string;
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
