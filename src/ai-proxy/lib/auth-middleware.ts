import { timingSafeEqual } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";

function tokensMatch(presented: string, expected: string): boolean {
    const presentedBuffer = Buffer.from(presented);
    const expectedBuffer = Buffer.from(expected);

    if (presentedBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return timingSafeEqual(presentedBuffer, expectedBuffer);
}

export function extractBearerToken(req: Request): string | null {
    const header = req.headers.get("Authorization");

    if (header) {
        const match = header.match(/^Bearer\s+(.+)$/i);

        if (match?.[1]) {
            return match[1];
        }
    }

    // Anthropic-shaped clients (Claude Code with ANTHROPIC_API_KEY, the Anthropic
    // SDKs) send the key as x-api-key and never set Authorization. Accepting it
    // here means every route authenticates the same way, whichever door is used.
    return req.headers.get("x-api-key");
}

export function requireProxyApiKey(req: Request, proxyApiKey: string): Response | null {
    const token = extractBearerToken(req);

    if (!token || !tokensMatch(token, proxyApiKey)) {
        return new Response(SafeJSON.stringify({ error: { message: "Invalid proxy API key", type: "auth_error" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }

    return null;
}
