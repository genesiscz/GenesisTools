export function isResponsesShapedBody(body: unknown): boolean {
    if (typeof body !== "object" || body === null) {
        return false;
    }

    const record = body as Record<string, unknown>;
    const hasInput = "input" in record;
    const hasMessages = "messages" in record;
    const hasResponsesFields = "reasoning" in record || "include" in record || "text" in record;

    if (hasInput && !hasMessages) {
        return true;
    }

    if (hasResponsesFields && !hasMessages) {
        return true;
    }

    return false;
}
