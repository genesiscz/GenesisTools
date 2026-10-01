import { tokenLink } from "@genesiscz/utils/browser-router/links";
import { type RouterConfig, route } from "@genesiscz/utils/browser-router/route";
import { mintToken } from "@genesiscz/utils/browser-router/tokens";

const FENCE = /^(```|~~~)/;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const AUTOLINK = /<([a-z][a-z0-9+.-]*:[^>]+)>/gi;
const BARE_HTTP = /https?:\/\/[^\s<>()[\]"'`]+/g;

/**
 * Every http(s) link in a note, in order and without repeats: markdown links, `<autolinks>`, and
 * bare URLs. Fenced code blocks are skipped, as `convertMarkdown` skips them.
 */
export function collectLinks(markdown: string): string[] {
    const found: string[] = [];
    let fenced = false;

    for (const line of markdown.split("\n")) {
        if (FENCE.test(line.trim())) {
            fenced = !fenced;
            continue;
        }

        if (fenced) {
            continue;
        }

        const rest = line
            .replace(MARKDOWN_LINK, (_whole, _text: string, href: string) => {
                found.push(href);
                return " ";
            })
            .replace(AUTOLINK, (_whole, href: string) => {
                found.push(href);
                return " ";
            });

        for (const bare of rest.match(BARE_HTTP) ?? []) {
            // A sentence that ends with the link keeps its period out of the URL.
            found.push(bare.replace(/[.,;:!?]+$/, ""));
        }
    }

    const http = found.filter((href) => /^https?:\/\//i.test(href));
    return [...new Set(http)];
}

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

/** Already a link on the router's own link host. */
export function isRouterLink(href: string, linkHost: string): boolean {
    try {
        const url = new URL(href);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.toLowerCase() === linkHost;
    } catch {
        return false;
    }
}

export function wrapLink(href: string, linkHost: string): string {
    return `https://${linkHost}/link/${encodeURIComponent(href)}`;
}

/**
 * Rewrites every local link (localhost, custom schemes) into a link on `config.linkHost` that a
 * click routes back to it. With `uses`, each becomes a minted `/t/<id>` link instead.
 */
export function convertMarkdown(markdown: string, config: RouterConfig & { linkHost: string }, uses?: number): string {
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
                const next = convertHref(href, config, uses);
                return next === href ? whole : `[${text}](${next})`;
            });
            const autolinked = linked.replace(AUTOLINK, (whole, href: string) => {
                const next = convertHref(href, config, uses);
                return next === href ? whole : `<${next}>`;
            });

            return autolinked.replace(
                /(^|[^\w(/])(genesis-md:\/\/[^\s<>)\]]+)/g,
                (whole, before: string, href: string) => {
                    const next = convertHref(href, config, uses);
                    return next === href ? whole : `${before}${next}`;
                }
            );
        })
        .join("\n");
}

function convertHref(href: string, config: RouterConfig & { linkHost: string }, uses?: number): string {
    if (!isLocalLink(href) || isRouterLink(href, config.linkHost)) {
        return href;
    }

    if (uses !== undefined) {
        return tokenLink(mintToken(href, uses), config.linkHost);
    }

    return httpsForLocal(href, config) ?? wrapLink(href, config.linkHost);
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

        for (const candidate of candidateUrls(rule.pattern, caps)) {
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

/**
 * The https URL a route pattern made of a literal prefix and one `(.*)` would match for this capture
 * (`https?://links\.example\.com/md/(.*)` gives `https://links.example.com/md/<rest>`).
 */
function candidateUrls(pattern: string, captures: string[]): string[] {
    const prefix = /^https\?:\/\/((?:[^\\()[\]{}.*+?^$|]|\\.)+)\(\.\*\)$/.exec(pattern);

    if (captures.length !== 1 || !prefix) {
        return [];
    }

    return [`https://${prefix[1].replace(/\\(.)/g, "$1")}${captures[0]}`];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
