import { defineTransclusion, TransclusionError } from "../registry";

const MAX_BODY_BYTES = 512 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&([a-z#0-9]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function clean(text: string): string {
    return decodeEntities(text.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}

function metaContent(html: string, names: string[]): string | undefined {
    for (const name of names) {
        const pattern = new RegExp(
            `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
            "i"
        );
        const match = pattern.exec(html);
        const value = match?.[1] ?? match?.[2];

        if (value?.trim()) {
            return clean(value);
        }
    }

    return undefined;
}

/** The title and a short excerpt of a page: its meta description, else its first real paragraph. */
export function summarizeHtml(html: string): { title?: string; excerpt?: string } {
    const title =
        metaContent(html, ["og:title", "twitter:title"]) ??
        clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
    const description = metaContent(html, ["description", "og:description", "twitter:description"]);
    const body = html.replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, " ");
    const paragraph = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((match) => clean(match[1]))
        .find((text) => text.length >= 40);
    return { ...(title ? { title } : {}), ...(description || paragraph ? { excerpt: description ?? paragraph } : {}) };
}

async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    while (bytes < MAX_BODY_BYTES && !signal.aborted) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        chunks.push(value);
        bytes += value.byteLength;
    }

    await reader.cancel();
    return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES));
}

export const urlTransclusion = defineTransclusion({
    name: "url",
    description:
        "A web page as a quoted card: its title and a short excerpt (meta description or first paragraph). " +
        "Live: show --recheck reports whether it changed. No cookies or auth are sent; the token timeout applies.",
    params: [
        { name: "url", type: "url", required: true, description: "An http(s) URL." },
        { name: "chars", type: "int", default: 300, description: "The longest excerpt, in characters." },
    ],
    examples: ['{{url url="https://rust-lang.github.io/mdBook/format/mdbook.html"}}'],
    action: "verify",
    async resolve(params, ctx) {
        const url = params.string("url");
        const response = await ctx.fetch(url, {
            signal: ctx.signal,
            redirect: "follow",
            headers: { "user-agent": "GenesisTools-transclude/1.0", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
        });

        if (!response.ok) {
            await response.body?.cancel();
            throw new TransclusionError(`HTTP ${response.status} from ${url}`);
        }

        const type = response.headers.get("content-type") ?? "";
        const body = await readCapped(response, ctx.signal);
        const summary = type.includes("html")
            ? summarizeHtml(body)
            : { excerpt: body.replace(/\s+/g, " ").trim() || undefined };
        const limit = Math.max(40, params.int("chars"));
        const excerpt =
            summary.excerpt && summary.excerpt.length > limit ? `${summary.excerpt.slice(0, limit)}…` : summary.excerpt;
        const host = new URL(response.url || url).host;
        // No fetch time in the card: the footer carries the capture time, and a time in the content
        // would make every `verify` recheck report "changed".
        const lines = [
            `> **[${(summary.title || host).replace(/[[\]]/g, "")}](${url})**`,
            ...(excerpt ? [">", `> ${excerpt}`] : []),
        ];

        return {
            markdown: lines.join("\n"),
            meta: {
                url,
                finalUrl: response.url || url,
                status: response.status,
                contentType: type,
                title: summary.title ?? null,
            },
            block: true,
            source: `${response.url || url} (HTTP ${response.status})`,
        };
    },
});
