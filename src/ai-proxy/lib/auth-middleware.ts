import { timingSafeEqual } from "node:crypto";
import { SafeJSON } from "@app/utils/json";

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

    if (!header) {
        return null;
    }

    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1] ?? null;
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
