import { describe, expect, test } from "bun:test";
import { collectAuthHealth } from "./auth-health";
import { parseWebLogFile, type WebLogLine } from "./web-log";

const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FAILED_RENEW = "11111111-2222-4333-8444-555555555555";
const LATER_RENEW = "66666666-7777-4888-9999-000000000000";
const SPACES = "https://api.spaces.skype.com";
const T0 = Date.parse("2026-03-02T10:00:00.000Z");

function telemetry(id: string, scenario: string, rest: string): string {
    return `AuthenticationService: [Auth]: [Telemetry][${id}][${scenario}] ${rest}`;
}

/** A silent renew that Entra ID refused, logged in chunks the way the Teams web client writes it. */
function failedRenew(at: number): WebLogLine[] {
    const head = `{"accountId":"${ACCOUNT}","isSilent":true,"endpointUrl":"${SPACES}","targetedUser":"${ACCOUNT}"`;
    const chunks = [
        "[start] - telemetry provider created for auth-service-module::acquireTokenV2, source: smartRetry-userAuth-3",
        `[module_end][success][scenarioEventData][${head},"operationStatus":"FAILED"`,
        `[stop][incomplete] [e]${head},"error":{"context":"authentication","subCo`,
        `[stop][incomplete] [e]ntext":"acquireTokenV2","message":"{\\"Description\\":\\"Recieved an error from AAD. Code: 'invalid_grant' description: '(pii)' suberror: 'token_expired'\\",\\"ErrorCode\\":\\"1200\\"}"},"errorCode":"Interacti`,
        `[stop][incomplete] [e]onRequired","status":"incomplete"}`,
    ];

    return chunks.map((chunk, i) => ({
        message: telemetry(FAILED_RENEW, "retry_interaction_required_token", chunk),
        at: at + i,
    }));
}

/** A token-warming renew that worked, with the status field split across two chunks. */
function laterSuccess(at: number): WebLogLine[] {
    const head = `{"accountId":"${ACCOUNT}","isSilent":true,"endpointUrl":"${SPACES}"`;
    return [`[stop] [scenarioEventData]${head},"sta`, `[stop] [scenarioEventData]tus":"success"}`].map((chunk, i) => ({
        message: telemetry(LATER_RENEW, "acquire_token_in_token_warming", chunk),
        at: at + i,
    }));
}

const leftRailError = (at: number): WebLogLine => ({
    message:
        'resolverUncaughtErrorBoundary__doNotAssignToGraphQLTeam: Uncaught error in a GraphQL resolver for operation "SimpleCollabLeftRailQuery"',
    at,
});

describe("collectAuthHealth", () => {
    test("a refused chat-token renew with a failing chat list needs an interactive sign-in", () => {
        const health = collectAuthHealth([...failedRenew(T0), leftRailError(T0 + 10)]);
        const spaces = health.resources.find((r) => r.resource === SPACES);

        expect(health.verdict).toBe("needs-sign-in");
        expect(spaces?.needsSignIn).toBe(true);
        expect(spaces?.chatCritical).toBe(true);
        expect(spaces?.failures).toBe(1);
        expect(spaces?.errors).toEqual(
            expect.arrayContaining(["invalid_grant", "token_expired", "InteractionRequired"])
        );
        expect(spaces?.errors).not.toContain("Interacti");
        expect(health.graphql).toEqual([
            { operation: "SimpleCollabLeftRailQuery", count: 1, firstAt: T0 + 10, lastAt: T0 + 10 },
        ]);
    });

    test("a later successful renew of the same resource clears it, even when its status field is split", () => {
        const later = T0 + 60 * 60_000;
        const health = collectAuthHealth([...laterSuccess(later), ...failedRenew(T0)]);
        const spaces = health.resources.find((r) => r.resource === SPACES);

        expect(spaces?.successes).toBe(1);
        expect(spaces?.lastSuccessAt).toBe(later + 1);
        expect(spaces?.needsSignIn).toBe(false);
        expect(health.verdict).toBe("healthy");
    });

    test("an old chat-list error is history, a recent one is a chat error with working tokens", () => {
        const end = T0 + 2 * 60 * 60_000;
        const old = collectAuthHealth([leftRailError(T0), ...laterSuccess(end)]);
        const recent = collectAuthHealth([...laterSuccess(end - 60_000), leftRailError(end)]);

        expect(old.verdict).toBe("healthy");
        expect(recent.verdict).toBe("chat-errors");
    });

    test("no lines is no log, not healthy", () => {
        expect(collectAuthHealth([]).verdict).toBe("no-log");
    });

    test("the file parser reads the logsArray body the renew lines come from", () => {
        const body = `{"logsArray":[{"message":"x","level":3,"levelName":"Info","timeStamp":"2026-03-02T10:00:00.000Z"},{"message":"y","timeStamp":"bad"}]}`;

        expect(parseWebLogFile(body)).toEqual([{ message: "x", at: T0 }]);
    });
});
