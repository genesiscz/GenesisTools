const HOSTNAME_RE =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function isValidHost(host: string): boolean {
    if (host === "localhost") {
        return true;
    }

    return HOSTNAME_RE.test(host);
}

export function parseHostsList(input: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const part of input.split(",")) {
        const host = part.trim().toLowerCase();

        if (!host || !isValidHost(host) || seen.has(host)) {
            continue;
        }

        seen.add(host);
        result.push(host);
    }

    return result;
}

export function formatHostsList(hosts: string[]): string {
    return hosts.join(", ");
}
