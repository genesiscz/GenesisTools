/** The URL to fetch: a bare host such as `example.com` gets `https://`. Anything that does not parse throws. */
export function ensureHttpUrl(input: string): string {
    const trimmed = input.trim();
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = URL.parse(candidate);

    if (!parsed?.hostname) {
        throw new Error(`Not a valid URL: "${input}"`);
    }

    return parsed.href;
}

/** The Jina Reader address that returns `url` as markdown rendered on Jina's side. */
export function buildJinaUrl(url: string): string {
    return `https://r.jina.ai/${ensureHttpUrl(url)}`;
}
