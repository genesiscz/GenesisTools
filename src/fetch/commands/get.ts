import { DEPTHS, isDepth } from "@app/mcp-web-reader/lib/convert";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { z } from "zod";
import { Fetcher } from "../lib/fetcher";
import { describeTransport, fetchUrl } from "../lib/read";
import { FETCH_MODES, isFetchMode, isTransportChoice, TRANSPORT_CHOICES } from "../lib/types";

const TOOL = "tools fetch";
const { log } = logger.scoped("fetch");

interface GetOptions {
    transport: string | boolean;
    mode: string | boolean;
    depth: string | boolean;
    tokens?: number;
    saveTokens?: boolean;
    headers?: string;
    out?: string;
    json?: boolean;
}

const headersSchema = z.record(z.string(), z.string());

function parsePositiveInt(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new InvalidArgumentError("expected a positive whole number");
    }

    return parsed;
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const parsed = headersSchema.safeParse(SafeJSON.parse(raw));
    if (!parsed.success) {
        throw new Error(`--headers must be a JSON object of string values: ${z.prettifyError(parsed.error)}`);
    }

    return parsed.data;
}

async function runGet(url: string, opts: GetOptions): Promise<void> {
    const flagContext = { tool: TOOL, subcommand: [] };
    const transport = await pickEnumFlag({
        ...flagContext,
        flag: "--transport",
        given: opts.transport,
        values: TRANSPORT_CHOICES,
        fallback: "auto",
        accepts: isTransportChoice,
    });
    if (!transport) {
        return;
    }

    const mode = await pickEnumFlag({
        ...flagContext,
        flag: "--mode",
        given: opts.mode,
        values: FETCH_MODES,
        fallback: "markdown",
        accepts: isFetchMode,
    });
    if (!mode) {
        return;
    }

    const depth = await pickEnumFlag({
        ...flagContext,
        flag: "--depth",
        given: opts.depth,
        values: DEPTHS,
        fallback: "basic",
        accepts: isDepth,
    });
    if (!depth) {
        return;
    }

    const fetcher = new Fetcher();
    try {
        const headers = parseHeaders(opts.headers);
        out.log.info(`Fetching ${pc.cyan(url)} (${mode}, transport ${transport})`);
        const result = await fetchUrl(fetcher, {
            url,
            mode,
            transport,
            headers,
            depth,
            maxTokens: opts.tokens,
            saveTokens: opts.saveTokens,
        });
        const summary =
            `HTTP ${result.status} via ${describeTransport(result)}: ${result.tokens} tokens` +
            (result.truncated ? " (truncated)" : "") +
            (result.jsonld
                ? `, ${result.jsonld.products.length} product(s) from ${result.jsonld.blocks} JSON-LD block(s)`
                : "");

        if (opts.json) {
            out.result({ ...result, text: result.mode === "jsonld" ? undefined : result.text });
            out.log.info(summary);
            return;
        }

        if (opts.out) {
            await Bun.write(opts.out, result.text);
            out.log.success(`Wrote ${opts.out}. ${summary}`);
            return;
        }

        out.println(result.text);
        out.log.info(summary);
    } catch (error) {
        log.debug({ error, url, mode, transport }, "fetch failed");
        out.log.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    } finally {
        await fetcher.close();
    }
}

/** `tools fetch <url>`: the default command. */
export function registerGetCommand(program: Command): void {
    program
        .command("get <url>", { isDefault: true })
        .description("Fetch a page as Markdown, raw HTML or its schema.org JSON-LD (what `fetch <url>` does)")
        .option("-t, --transport [transport]", `How to reach the page: ${TRANSPORT_CHOICES.join(" | ")}`, "auto")
        .option("-m, --mode [mode]", `Output: ${FETCH_MODES.join(" | ")}`, "markdown")
        .option("-d, --depth [depth]", "Markdown: basic | advanced (advanced adds YAML front matter)", "basic")
        .option("-T, --tokens <n>", "Return at most this many tokens (markdown and raw)", parsePositiveInt)
        .option("-s, --save-tokens", "Compact whitespace (raw) or code blocks (markdown)")
        .option("--headers <json>", "Extra request headers as a JSON object, sent only to the page's own origin")
        .option("-o, --out <path>", "Write the text to a file instead of stdout")
        .option("--json", "Print the whole result (source, status, transport, escalation, extraction) as JSON")
        .addHelpText(
            "after",
            `\nExamples:\n  ${toolCommand("fetch", "https://example.com")}\n` +
                `  ${toolCommand("fetch", "https://www.alza.cz/...", "--transport", "chrome", "--mode", "jsonld")}\n`
        )
        .action(runGet);
}
