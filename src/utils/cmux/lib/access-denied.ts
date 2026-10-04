const ACCESS_DENIED_PATTERN = /Access denied - only processes started inside cmux can connect/;

/**
 * True when cmux's own stderr says the caller was not started inside a cmux pane
 * (its default socket access mode). Distinct from a dead or livelocked socket:
 * cmux is answering, it is just refusing this particular caller (#446 item 2).
 */
export function isCmuxAccessDenied(text: string | undefined): boolean {
    return text !== undefined && ACCESS_DENIED_PATTERN.test(text);
}
