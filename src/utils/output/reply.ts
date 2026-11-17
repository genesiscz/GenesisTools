/**
 * The one answer object of a library method. Each door (CLI, MCP, REPL, the service) renders it in its own form;
 * the library never prints.
 */

export interface Diagnostic {
    code: string;
    severity: "error" | "warning" | "info";
    message: string;
    field?: string;
}

/** A next step for the caller: a method call each door prints in its own form, or a question for the user. */
export interface NextAction {
    do: string;
    call?: { method: string; params: Record<string, unknown> };
    ask?: string;
}

export interface ReplyReceipt {
    requestId?: string;
    changes: number[];
    replayed: boolean;
}

export type Reply<T> = {
    v: 1;
    verb: string;
    diagnostics: Diagnostic[];
    next: NextAction[];
    dryRun?: true;
    receipt?: ReplyReceipt;
} & ({ ok: true; data: T } | { ok: false });

export function okReply<T>(
    verb: string,
    data: T,
    extra: { diagnostics?: Diagnostic[]; next?: NextAction[]; receipt?: ReplyReceipt; dryRun?: boolean } = {}
): Reply<T> {
    return {
        v: 1,
        verb,
        ok: true,
        data,
        diagnostics: extra.diagnostics ?? [],
        next: extra.next ?? [],
        ...(extra.receipt ? { receipt: extra.receipt } : {}),
        ...(extra.dryRun ? { dryRun: true as const } : {}),
    };
}

export function failReply<T = never>(verb: string, diagnostics: Diagnostic[], next: NextAction[] = []): Reply<T> {
    return { v: 1, verb, ok: false, diagnostics, next };
}

export function errorDiagnostic(code: string, message: string, field?: string): Diagnostic {
    return { code, severity: "error", message, ...(field !== undefined ? { field } : {}) };
}

export function warningDiagnostic(code: string, message: string, field?: string): Diagnostic {
    return { code, severity: "warning", message, ...(field !== undefined ? { field } : {}) };
}

export function infoDiagnostic(code: string, message: string): Diagnostic {
    return { code, severity: "info", message };
}
