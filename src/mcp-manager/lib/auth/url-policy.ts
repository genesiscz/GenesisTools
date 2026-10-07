import {
    _resetOutboundLookupForTest,
    _setOutboundLookupForTest,
    assertNoOutboundEscalation,
    assertNoOutboundEscalationSyntax,
    isPrivateHost,
    type OutboundLookup,
    OutboundUrlPolicyError,
    resolveNoOutboundEscalation,
} from "@genesiscz/utils/net/outbound-policy";
import { untilAborted } from "@genesiscz/utils/net/pinned-fetch";

export { isPrivateHost, OutboundUrlPolicyError };

export function _setLookupForTest(fn: OutboundLookup): void {
    _setOutboundLookupForTest(fn);
}

export function _resetLookupForTest(): void {
    _resetOutboundLookupForTest();
}

/**
 * Where discovery is allowed to send a request.
 *
 * Every URL in the RFC 9728 / RFC 8414 chain after the first one is chosen by the
 * REMOTE server: `resource_metadata` comes out of its `WWW-Authenticate` header, and
 * `authorization_servers[0]` out of a document it serves. A hostile or compromised MCP
 * endpoint can therefore aim this process at `169.254.169.254`, at a private LAN host,
 * or at a loopback port that another local service is listening on.
 *
 * The rule is "no escalation": a PUBLIC MCP server may only send us to public hosts. A
 * server we already reach over loopback or a private address is by definition already
 * inside that boundary, so it keeps working — which is what local development and the
 * integration tests need.
 */

export function assertDiscoveryTargetSyntax(target: string, origin: string): URL {
    return assertNoOutboundEscalationSyntax(target, origin);
}

/** A DNS answer for a policy check, like every credential request here, gets 15 s. */
const DISCOVERY_DNS_TIMEOUT_MS = 15_000;

/**
 * The check alone, for an endpoint that is validated now and fetched later. Its lookup is bounded
 * so a stalled resolver ends the login with an error instead of holding it forever.
 */
export async function assertDiscoveryTarget(
    target: string,
    origin: string,
    { timeoutMs = DISCOVERY_DNS_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<URL> {
    return untilAborted(assertNoOutboundEscalation(target, origin), AbortSignal.timeout(timeoutMs));
}

/** The checked URL plus the addresses a request to it must be pinned to (null: no pin needed). */
export async function resolveDiscoveryTarget(
    target: string,
    origin: string
): Promise<{ url: URL; addresses: string[] | null }> {
    return resolveNoOutboundEscalation(target, origin);
}
