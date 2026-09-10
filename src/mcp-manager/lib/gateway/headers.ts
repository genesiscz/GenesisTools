import { LOOPBACK_HOSTS } from "@genesiscz/utils/ai/oauth/callback-server";
import { GATEWAY_HEADER } from "../auth/constants.ts";

const STRIP_TO_UPSTREAM = new Set([
    GATEWAY_HEADER.toLowerCase(),
    "authorization",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
]);

const STRIP_FROM_UPSTREAM = new Set(["set-cookie", "www-authenticate"]);

export function loopbackHostOk(hostHeader: string | null): boolean {
    const host = (hostHeader ?? "").replace(/:\d+$/, "");

    return LOOPBACK_HOSTS.has(host);
}

export function localTokenMatches(request: Request, expected: string): boolean {
    const got = request.headers.get(GATEWAY_HEADER);

    return Boolean(got && expected && got === expected);
}

export function headersToUpstream(request: Request, accessToken: string): Headers {
    const out = new Headers();

    for (const [key, value] of request.headers.entries()) {
        if (STRIP_TO_UPSTREAM.has(key.toLowerCase())) {
            continue;
        }

        out.set(key, value);
    }

    out.set("Authorization", `Bearer ${accessToken}`);

    return out;
}

export function headersToClient(upstream: Headers): Headers {
    const out = new Headers();

    for (const [key, value] of upstream.entries()) {
        if (STRIP_FROM_UPSTREAM.has(key.toLowerCase())) {
            continue;
        }

        out.set(key, value);
    }

    return out;
}
