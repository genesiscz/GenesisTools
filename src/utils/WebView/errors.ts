export class WebViewError extends Error {
    readonly instanceId: string;

    constructor(message: string, instanceId: string) {
        super(message);
        this.name = "WebViewError";
        this.instanceId = instanceId;
    }
}

export class WebViewNavigationError extends WebViewError {
    readonly url: string;
    override readonly cause: unknown;

    constructor(url: string, instanceId: string, cause: unknown) {
        super(`Navigation failed for "${url}": ${String(cause)}`, instanceId);
        this.name = "WebViewNavigationError";
        this.url = url;
        this.cause = cause;
    }
}

export class WebViewTimeoutError extends WebViewError {
    readonly operation: string;
    readonly timeoutMs: number;

    constructor(operation: string, timeoutMs: number, instanceId: string) {
        super(`WebView operation "${operation}" timed out after ${timeoutMs}ms`, instanceId);
        this.name = "WebViewTimeoutError";
        this.operation = operation;
        this.timeoutMs = timeoutMs;
    }
}

export class WebViewEvaluateError extends WebViewError {
    readonly expression: string;
    override readonly cause: unknown;

    constructor(expression: string, instanceId: string, cause: unknown) {
        super(`evaluate() failed: ${String(cause)}`, instanceId);
        this.name = "WebViewEvaluateError";
        this.expression = expression;
        this.cause = cause;
    }
}
