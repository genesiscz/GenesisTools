/** The JSON-RPC 2.0 error codes every server answers; a service adds its own from 1001 (`RPC_ERRORS` of the recorder). */
export const JSON_RPC_ERRORS = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
} as const;

/**
 * The code a request cancelled by `$/cancel` answers with. The transport answers it for every service, so it lives
 * here; the recorder's error table names it `cancelled`, beside its own codes.
 */
export const RPC_CANCELLED = 1013;

/**
 * What the place that throws knows about the issue a failure would become: its title, without the tool prefix. The
 * tool is never typed at a throw: the reply fills it from the process that answered (`ErrorIssue.tool`).
 */
export interface IssueHint {
    /** A short title that groups the same failure ("Moment refused: too-long"); the error's message when absent. */
    title?: string;
}

/** The issue of a failed call, as an error reply carries it: the tool that answered, and the thrower's title. */
export interface ErrorIssue extends IssueHint {
    /** The tool whose process answered (`meetings`); the issue title becomes `[meetings] <title>`. */
    tool: string;
}

export interface RpcErrorOptions {
    /** The error this refusal reports; its stack is the one the reply carries. */
    cause?: unknown;
    issue?: IssueHint | ErrorIssue;
    /** The stack supplied by a remote peer, replacing this client's construction stack. */
    stack?: string;
}

/** A refused call: the code goes to the caller in the error reply, the message as its text. */
export class RpcError extends Error {
    readonly issue?: IssueHint | ErrorIssue;

    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown,
        options: RpcErrorOptions = {}
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "RpcError";
        this.issue = options.issue;
        if (options.stack !== undefined) {
            this.stack = options.stack;
        }
    }
}

/** The body of a JSON-RPC error reply. `stack` and `issue` are this repo's members beside the standard three. */
export interface RpcErrorBody {
    code: number;
    message: string;
    data?: unknown;
    /** The stack of the error that failed the call (its `cause` when it wraps one), as V8 printed it. */
    stack?: string;
    issue: ErrorIssue;
}

function stackOf(error: unknown): string | undefined {
    return error instanceof Error && typeof error.stack === "string" && error.stack.length > 0
        ? error.stack
        : undefined;
}

/** `error.issue` of any thrown value that carries one (an RpcError, or an Error a handler gave an `issue`). */
export function issueHintOf(error: unknown): IssueHint | undefined {
    if (typeof error !== "object" || error === null || !("issue" in error)) {
        return undefined;
    }

    const issue = error.issue;
    if (typeof issue !== "object" || issue === null) {
        return undefined;
    }

    const title = "title" in issue && typeof issue.title === "string" ? issue.title.trim() : "";
    return title ? { title } : {};
}

/**
 * The standard JSON-RPC members of the error of a failed call: the code (`internal` for anything that is no RpcError),
 * the message and the data. A dialect without error evidence replies with these alone.
 */
export function rpcStandardErrorBody(error: unknown): Omit<RpcErrorBody, "stack" | "issue"> {
    const rpc = error instanceof RpcError ? error : undefined;
    return {
        code: rpc ? rpc.code : JSON_RPC_ERRORS.internal,
        message: error instanceof Error ? error.message : String(error),
        ...(rpc?.data !== undefined ? { data: rpc.data } : {}),
    };
}

/**
 * The error member of a reply to a failed call: the standard members ({@link rpcStandardErrorBody}), the stack of the
 * error that caused it, and the issue with `tool` filled from the answering process.
 */
export function rpcErrorBody(error: unknown, tool: string): RpcErrorBody {
    const rpc = error instanceof RpcError ? error : undefined;
    const stack = stackOf(rpc?.cause) ?? stackOf(error);
    const hint = issueHintOf(error) ?? issueHintOf(rpc?.cause);
    return {
        ...rpcStandardErrorBody(error),
        ...(stack ? { stack } : {}),
        issue: { tool, ...(hint?.title ? { title: hint.title } : {}) },
    };
}
