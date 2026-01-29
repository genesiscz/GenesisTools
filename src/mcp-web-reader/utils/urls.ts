export function resolveUrl(baseUrl: string, href: string): string {
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return href;
    }
}

export function ensureHttpUrl(url: string): string {
    if (!/^https?:\/\//i.test(url)) {
        return `https://${url}`;
    }
    return url;
}

export function buildJinaUrl(url: string): string {
    const parsed = new URL(ensureHttpUrl(url));
    return `https://r.jina.ai/${parsed.href}`;
}
