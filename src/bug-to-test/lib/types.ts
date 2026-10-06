import {
    type BrowserAction,
    type BrowserEvidence,
    type BrowserLocator,
    validBrowserLocator,
} from "@app/chrome-devtools/lib/action-recording";

export type { BrowserAction, BrowserEvidence, BrowserLocator };
export interface BugExpectation {
    description: string;
    kind: "text" | "value" | "visible" | "url";
    locator?: BrowserLocator;
    expected: string;
}
export interface BugRecording {
    version: 1;
    id: string;
    title: string;
    initialUrl: string;
    actions: BrowserAction[];
    evidence: BrowserEvidence[];
    expectation?: BugExpectation;
    workspace?: string;
    removedActionIds?: string[];
    triggerActionId?: string;
}
export interface VerificationResult {
    status: "intended-failure" | "passed" | "infrastructure-error" | "cancelled" | "timed-out";
    message: string;
    testHash: string;
    trace?: string;
    report: string;
    durationMs: number;
    exitCode: number;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Recording must contain JSON objects.");
    }
    return value as Record<string, unknown>;
}
function string(value: unknown, limit = 4000): string {
    if (typeof value !== "string" || value.length > limit) {
        throw new Error("Recording contains a missing or oversized string.");
    }
    return value;
}
export function httpUrl(value: unknown): string {
    const url = new URL(string(value));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Use an HTTP URL without embedded credentials.");
    }
    return url.toString();
}
export function parseExpectation(value: unknown): BugExpectation {
    const item = object(value);
    const kind = item.kind;
    if (!["text", "value", "visible", "url"].includes(String(kind))) {
        throw new Error("Choose a supported assertion type.");
    }
    const description = string(item.description).trim();
    const expected = string(item.expected);
    if (!description || !expected.trim()) {
        throw new Error("State the expected behavior and expected value explicitly.");
    }
    if (kind !== "url" && !validBrowserLocator(item.locator)) {
        throw new Error("Choose a unique target locator for the assertion.");
    }
    if (kind === "visible" && !["true", "false"].includes(expected)) {
        throw new Error("Visibility expectation must be true or false.");
    }
    if (kind === "url") {
        httpUrl(expected);
    }
    return {
        description,
        kind: kind as BugExpectation["kind"],
        expected,
        locator: kind === "url" ? undefined : (item.locator as BrowserLocator),
    };
}
export function parseRecording(value: unknown): BugRecording {
    const item = object(value);
    if (
        item.version !== 1 ||
        !Array.isArray(item.actions) ||
        !Array.isArray(item.evidence) ||
        item.actions.length > 200 ||
        item.evidence.length > 500
    ) {
        throw new Error("Unsupported recording version or recording limit exceeded.");
    }
    const actions = item.actions.map((raw) => {
        const action = object(raw);
        if (
            !["click", "fill", "select", "press", "navigate"].includes(String(action.kind)) ||
            typeof action.excluded !== "boolean" ||
            typeof action.at !== "number"
        ) {
            throw new Error("Recording contains an invalid action.");
        }
        if (action.kind !== "navigate" && !validBrowserLocator(action.locator)) {
            throw new Error("Recorded action needs a valid locator.");
        }
        if (["fill", "select", "press"].includes(String(action.kind)) && typeof action.value !== "string") {
            throw new Error("Recorded input action needs a value.");
        }
        return {
            id: string(action.id, 100),
            kind: action.kind as BrowserAction["kind"],
            excluded: action.excluded,
            at: action.at,
            locator: action.locator as BrowserLocator | undefined,
            value: action.value === undefined ? undefined : string(action.value),
            url: action.kind === "navigate" ? httpUrl(action.url) : undefined,
            sourceUrl: action.sourceUrl === undefined ? undefined : httpUrl(action.sourceUrl),
        };
    });
    const evidence = item.evidence.map((raw) => {
        const entry = object(raw);
        if (
            !["console", "network", "navigation", "warning"].includes(String(entry.kind)) ||
            typeof entry.excluded !== "boolean" ||
            typeof entry.at !== "number"
        ) {
            throw new Error("Recording contains invalid browser evidence.");
        }
        return {
            id: string(entry.id, 100),
            kind: entry.kind as BrowserEvidence["kind"],
            text: string(entry.text),
            excluded: entry.excluded,
            at: entry.at,
        };
    });
    return {
        version: 1,
        id: string(item.id, 100),
        title: string(item.title, 200),
        initialUrl: httpUrl(item.initialUrl),
        actions,
        evidence,
        expectation: item.expectation === undefined ? undefined : parseExpectation(item.expectation),
        workspace: typeof item.workspace === "string" ? item.workspace : undefined,
        triggerActionId: typeof item.triggerActionId === "string" ? string(item.triggerActionId, 100) : undefined,
        removedActionIds: Array.isArray(item.removedActionIds)
            ? item.removedActionIds.map((id) => string(id, 100))
            : undefined,
    };
}
