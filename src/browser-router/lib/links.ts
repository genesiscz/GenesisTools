import { type RouterConfig, route, UNWRAP_PATTERN } from "./route";
import { mintToken } from "./tokens";

const FENCE = /^(```|~~~)/;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const AUTOLINK = /<([a-z][a-z0-9+.-]*:[^>]+)>/gi;

/** localhost, loopback, and custom schemes. Ordinary https websites stay as they are. */
export function isLocalLink(href: string): boolean {
    let url: URL;

    try {
        url = new URL(href);
    } catch {
        return false;
    }

    // The router unwraps only http(s) and genesis-md, so another scheme is left as written.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return url.protocol === "genesis-md:";
    }

    const host = url.hostname.toLowerCase();

    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
        return true;
    }

    return host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal");
}

export function isRouterLink(href: string): boolean {
    try {
        const url = new URL(href);
        const host = url.hostname.toLowerCase();
        const routerHost =
            host === "genesis.tools" || ((host === "127.0.0.1" || host === "localhost") && url.port === "6666");
        return (url.protocol === "http:" || url.protocol === "https:") && routerHost;
    } catch {
        return false;
    }
}

export function wrapLink(href: string): string {
    return `https://genesis.tools/link/${encodeURIComponent(href)}`;
}

export function tokenLink(id: string): string {
    return `https://genesis.tools/t/${id}`;
}

export function convertMarkdown(markdown: string, uses?: number, config?: RouterConfig): string {
    const lines = markdown.split("\n");
    let fenced = false;

    return lines
        .map((line) => {
            if (FENCE.test(line.trim())) {
                fenced = !fenced;
                return line;
            }

            if (fenced) {
                return line;
            }

            const linked = line.replace(MARKDOWN_LINK, (whole, text: string, href: string) => {
                const next = convertHref(href, uses, config);
                return next === href ? whole : `[${text}](${next})`;
            });
            const autolinked = linked.replace(AUTOLINK, (whole, href: string) => {
                const next = convertHref(href, uses, config);
                return next === href ? whole : `<${next}>`;
            });

            return autolinked.replace(
                /(^|[^\w(/])(genesis-md:\/\/[^\s<>)\]]+)/g,
                (whole, before: string, href: string) => {
                    const next = convertHref(href, uses, config);
                    return next === href ? whole : `${before}${next}`;
                }
            );
        })
        .join("\n");
}

function convertHref(href: string, uses?: number, config?: RouterConfig): string {
    if (!isLocalLink(href) || isRouterLink(href)) {
        return href;
    }

    if (uses !== undefined) {
        return tokenLink(mintToken(href, uses));
    }

    if (config) {
        const pretty = httpsForLocal(href, config);

        if (pretty) {
            return pretty;
        }
    }

    return wrapLink(href);
}

/** An https URL that a saved `open` route turns back into this exact link. */
export function httpsForLocal(href: string, config: RouterConfig): string | null {
    let target: string;

    try {
        target = new URL(href).href;
    } catch {
        return null;
    }

    for (const rule of config.routes) {
        if (rule.action.type !== "open") {
            continue;
        }

        const caps = matchOpenTemplate(rule.action.to, target);

        if (!caps) {
            continue;
        }

        for (const candidate of candidateUrls(caps, config)) {
            try {
                const decision = route(candidate, config);

                if (decision.kind === "open" && new URL(decision.url).href === target) {
                    return candidate;
                }
            } catch {}
        }
    }

    return null;
}

function matchOpenTemplate(template: string, href: string): string[] | null {
    let source = "^";
    const marker = /\$\$|\$(\d+)/g;
    let last = 0;
    let found: RegExpExecArray | null = marker.exec(template);

    while (found) {
        source += escapeRegExp(template.slice(last, found.index));

        if (found[0] === "$$") {
            source += "\\$";
        } else {
            const rest = template.slice(marker.lastIndex);
            const nextLiteral = rest.split(/\$\$|\$\d+/)[0] ?? "";
            source += nextLiteral.length === 0 ? "(.*)" : "(.*?)";
        }

        last = marker.lastIndex;
        found = marker.exec(template);
    }

    source += `${escapeRegExp(template.slice(last))}$`;
    const match = new RegExp(source).exec(href);

    return match ? match.slice(1) : null;
}

function candidateUrls(captures: string[], config: RouterConfig): string[] {
    if (captures.length !== 1) {
        return [];
    }

    const rest = captures[0];
    const urls = [`https://127.0.0.1:6666/${rest}`, `http://127.0.0.1:6666/${rest}`, `http://localhost:6666/${rest}`];

    if (config.allowAliases !== false) {
        for (const alias of config.aliases ?? []) {
            urls.unshift(`https://${alias.host}/${rest}`);
        }
    }

    return urls;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { UNWRAP_PATTERN };
