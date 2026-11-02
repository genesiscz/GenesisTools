import { DEPTHS } from "@app/mcp-web-reader/lib/convert";
import { z } from "zod";
import type { Fetcher } from "../lib/fetcher";
import { describeTransport, type FetchResult, fetchUrl } from "../lib/read";
import { TRANSPORT_CHOICES } from "../lib/types";

/**
 * The `fetch_*` tools, defined once. `tools fetch mcp` serves them alone and the genesis-tools server serves them as
 * its lazily loaded `fetch` group; both call these `run` functions, which call `fetchUrl`, the CLI's operation.
 */

const url = z.string().min(1).describe("Page URL; a bare host such as example.com gets https://");
const transport = z
    .enum(TRANSPORT_CHOICES)
    .optional()
    .describe(
        "plain = Bun fetch; chrome = a real Chrome TLS/HTTP2 fingerprint (libcurl-impersonate, passes Cloudflare bot walls); " +
            "auto (default) = plain, then chrome once on 403/429/503 or a recognised challenge page"
    );
const headers = z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra request headers, sent only to the page's own origin");
const tokens = z.number().int().positive().optional().describe("Return at most this many tokens; the rest is cut");
const saveTokens = z.boolean().optional().describe("Compact whitespace (raw) or code blocks (markdown)");

const markdownSchema = z
    .object({
        url,
        transport,
        headers,
        depth: z.enum(DEPTHS).optional().describe("advanced = YAML front matter (title, URL, author, date) first"),
        tokens,
        save_tokens: saveTokens,
    })
    .strict();
const rawSchema = z.object({ url, transport, headers, tokens, save_tokens: saveTokens }).strict();
const jsonldSchema = z.object({ url, transport, headers }).strict();

export interface FetchTool {
    name: string;
    description: string;
    schema: z.ZodType;
    run(input: { fetcher: Fetcher; args: unknown; signal?: AbortSignal }): Promise<FetchResult>;
}

const TRANSPORT_NOTE =
    " The result's first line names the transport that answered. A bot challenge that even chrome did not pass is " +
    "an error, never returned as content.";

export const FETCH_TOOLS: FetchTool[] = [
    {
        name: "fetch_markdown",
        description:
            "Fetch a web page and return its main content as Markdown (navigation, footers, ads and cookie banners " +
            "dropped, links absolute). Works on sites behind Cloudflare and similar bot walls through the chrome " +
            `transport.${TRANSPORT_NOTE}`,
        schema: markdownSchema,
        run: ({ fetcher, args, signal }) => {
            const input = markdownSchema.parse(args);
            return fetchUrl(fetcher, {
                url: input.url,
                mode: "markdown",
                transport: input.transport,
                headers: input.headers,
                depth: input.depth,
                maxTokens: input.tokens,
                saveTokens: input.save_tokens,
                signal,
            });
        },
    },
    {
        name: "fetch_raw",
        description: `Fetch the raw HTML of a web page, through a Chrome fingerprint when the site needs one.${TRANSPORT_NOTE}`,
        schema: rawSchema,
        run: ({ fetcher, args, signal }) => {
            const input = rawSchema.parse(args);
            return fetchUrl(fetcher, {
                url: input.url,
                mode: "raw",
                transport: input.transport,
                headers: input.headers,
                maxTokens: input.tokens,
                saveTokens: input.save_tokens,
                signal,
            });
        },
    },
    {
        name: "fetch_jsonld",
        description:
            "Fetch a web page and return its schema.org JSON-LD as JSON: every Product (name, brand, sku, gtin, " +
            "rating, price range, and each offer with seller, price, currency, availability), the BreadcrumbList " +
            "trail, and the other typed nodes by name. For price comparison pages (one offer per shop) and product " +
            "pages. The JSON carries `url` and `transport` (and `escalatedFrom` when auto retried through chrome).",
        schema: jsonldSchema,
        run: ({ fetcher, args, signal }) => {
            const input = jsonldSchema.parse(args);
            return fetchUrl(fetcher, {
                url: input.url,
                mode: "jsonld",
                transport: input.transport,
                headers: input.headers,
                signal,
            });
        },
    },
];

/**
 * The text an MCP client sees. JSON-LD is already a JSON document naming its transport; markdown and raw get one
 * HTML comment line first (a no-op in Markdown), because many clients never show `_meta`.
 */
export function toolText(result: FetchResult): string {
    if (result.mode === "jsonld") {
        return result.text;
    }

    const truncated = result.truncated ? `, truncated to ${result.tokens} tokens` : "";
    return `<!-- fetched ${result.source} (HTTP ${result.status}) via ${describeTransport(result)}${truncated} -->\n${result.text}`;
}
