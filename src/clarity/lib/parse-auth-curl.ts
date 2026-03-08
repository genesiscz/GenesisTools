import { parseCurl } from "@app/utils/curl";

export interface ClarityAuthFromCurl {
    baseUrl: string;
    authToken: string;
    sessionId: string;
    cookies: string;
}

/**
 * Extract Clarity auth credentials (baseUrl, authToken, sessionId) from a cURL command.
 * Throws descriptive errors if required fields are missing.
 */
export function parseAuthCurl(curl: string): ClarityAuthFromCurl {
    const parsed = parseCurl(curl);

    const urlObj = new URL(parsed.url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

    const authToken =
        parsed.headers.authToken || parsed.headers.AuthToken || parsed.headers.AUTHTOKEN || parsed.headers.authtoken;

    if (!authToken) {
        throw new Error("No authToken header found in cURL");
    }

    const sessionId = parsed.cookies.sessionId || parsed.cookies.JSESSIONID;

    if (!sessionId) {
        throw new Error("No sessionId cookie found in cURL");
    }

    const cookies = Object.entries(parsed.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");

    return { baseUrl, authToken, sessionId, cookies };
}
