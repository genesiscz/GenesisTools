const TRACKING = /^(utm_|fbclid$|gclid$|mc_eid$)/;
const MAX_UNWRAP_DEPTH = 5;

/** Unwrap Outlook safelinks and common redirectors, then drop tracking parameters. */
export function cleanUrl(input: string): string {
    let url: URL;

    try {
        url = new URL(input);
    } catch {
        return input;
    }

    // A redirector can wrap another (an Outlook safelink around a Google /url link): unwrap until the URL
    // stops changing, as the native router's cleanLink recurses. The cap stops a pathological chain.
    for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
        const inner = unwrap(url);

        if (inner === url) {
            break;
        }

        url = inner;
    }

    for (const key of [...url.searchParams.keys()]) {
        if (TRACKING.test(key)) {
            url.searchParams.delete(key);
        }
    }

    return url.href;
}

function unwrap(url: URL): URL {
    const host = url.hostname.toLowerCase();

    if (onDomain(host, "safelinks.protection.outlook.com")) {
        return nested(url.searchParams.get("url")) ?? url;
    }

    if ((host === "www.google.com" || host === "google.com") && url.pathname === "/url") {
        return nested(url.searchParams.get("q")) ?? url;
    }

    const redirected = url.searchParams.get("url") ?? url.searchParams.get("q");

    if (redirected && (onDomain(host, "slack.com") || onDomain(host, "teams.microsoft.com"))) {
        return nested(redirected) ?? url;
    }

    return url;
}

/** The domain itself or a subdomain of it; `notslack.com` is not `slack.com`. */
function onDomain(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
}

/** `searchParams.get` already percent-decodes; a second decode would turn `%26` into `&`. */
function nested(value: string | null): URL | null {
    if (!value) {
        return null;
    }

    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
        return null;
    }
}
