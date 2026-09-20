import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    API_ENVELOPE_TOKENS,
    countText,
    DEFAULT_MODEL,
    METHODS,
    type TokenCount,
    type TokenMethod,
    toCount,
} from "../lib/tokens";

interface TokensOptions {
    method?: string;
    model?: string;
    slice?: string;
    json?: boolean;
}

async function readInput(target: string): Promise<{ label: string; text: string } | null> {
    if (target === "-") {
        return { label: "stdin", text: await Bun.stdin.text() };
    }

    const absolute = resolve(target);

    if (!existsSync(absolute)) {
        logger.error({ target }, "Input not found");
        return null;
    }

    // A file outside the cwd relativises to a wall of `../`, so keep it absolute.
    const rel = relative(process.cwd(), absolute);
    const label = rel && !rel.startsWith("..") ? rel : absolute;

    return { label, text: await Bun.file(absolute).text() };
}

function resolveMethod(raw: string | undefined): TokenMethod | null {
    const method = (raw ?? "claude-local") as TokenMethod;

    if (!METHODS.includes(method)) {
        // The base excludes the subcommand, which argv already carries.
        out.println(suggestEnumFlag("tools ai", "--method", METHODS));
        process.exitCode = 1;
        return null;
    }

    return method;
}

function render(counts: TokenCount[], method: TokenMethod, model: string, sliced: number | null): void {
    renderCliHeader("Token counts", method === "claude-api" ? `${model} via count_tokens` : `${method} (local)`);

    const table = createBoxTable(["INPUT", "CHARS", "TOKENS", "CHARS/TOKEN"]);
    const widest = counts.reduce((max, count) => Math.max(max, count.tokens), 0);

    for (const count of counts) {
        const share = widest > 0 ? count.tokens / widest : 0;
        table.push([
            pc.white(count.label),
            count.chars.toLocaleString("en-US"),
            share >= 0.999 ? pc.yellow(count.tokens.toLocaleString("en-US")) : count.tokens.toLocaleString("en-US"),
            pc.cyan(count.charsPerToken.toFixed(2)),
        ]);
    }

    out.println(table.toString());

    if (sliced !== null) {
        ui.raw("");
        ui.raw(pc.dim(`every input truncated to ${sliced.toLocaleString("en-US")} chars, so this ranks density only`));
    }

    if (method === "claude-api") {
        ui.raw(pc.dim(`includes ~${API_ENVELOPE_TOKENS} tokens of message framing per input`));
    }
}

async function runCounts(targets: string[], options: TokensOptions): Promise<void> {
    const method = resolveMethod(options.method);

    if (!method) {
        return;
    }

    const model = options.model ?? DEFAULT_MODEL;
    const apiKey = env.ai.anthropic.getKey();

    if (method === "claude-api" && !apiKey) {
        logger.error(
            "ANTHROPIC_API_KEY is required for --method claude-api. Subscription accounts are deliberately not used, " +
                "because binding one can rotate a single-use refresh token."
        );
        process.exitCode = 1;
        return;
    }

    const slice = options.slice ? Number.parseInt(options.slice, 10) : null;

    if (slice !== null && (!Number.isFinite(slice) || slice <= 0)) {
        logger.error({ slice: options.slice }, "--slice must be a positive number of characters");
        process.exitCode = 1;
        return;
    }

    const counts: TokenCount[] = [];

    for (const target of targets) {
        const input = await readInput(target);

        if (!input) {
            process.exitCode = 1;
            continue;
        }

        const text = slice === null ? input.text : input.text.slice(0, slice);

        if (slice !== null && input.text.length < slice) {
            logger.warn({ input: input.label, have: input.text.length, want: slice }, "Input shorter than --slice");
        }

        counts.push(toCount(input.label, text, await countText(text, { method, model, apiKey }), method));
    }

    if (counts.length === 0) {
        return;
    }

    if (options.json) {
        out.result({ method, model: method === "claude-api" ? model : undefined, slice, counts });
        return;
    }

    render(counts, method, model, slice);
}

export function registerTokensCommands(program: Command): void {
    const tokens = program.command("tokens").description("Count and compare tokens across files, formats and methods");

    tokens
        .command("count", { isDefault: true })
        .description("Token count per input, with characters per token")
        .argument("<paths...>", "Files to measure, or - for stdin")
        .option("--method [name]", `One of ${METHODS.join(", ")} (default: claude-local)`)
        .option("--model <id>", `Model for --method claude-api (default: ${DEFAULT_MODEL})`)
        .option("--json", "Emit machine-readable JSON")
        .action(async (paths: string[], options: TokensOptions) => {
            await runCounts(paths, options);
        });

    tokens
        .command("compare")
        .description("Rank inputs by token density, optionally over an equal slice of each")
        .argument("<paths...>", "Files to compare, or - for stdin")
        .option("--slice <chars>", "Truncate every input to this many characters first")
        .option("--method [name]", `One of ${METHODS.join(", ")} (default: claude-local)`)
        .option("--model <id>", `Model for --method claude-api (default: ${DEFAULT_MODEL})`)
        .option("--json", "Emit machine-readable JSON")
        .action(async (paths: string[], options: TokensOptions) => {
            if (paths.length < 2 && isInteractive()) {
                logger.warn("compare is most useful with two or more inputs");
            }

            await runCounts(paths, options);
        });
}
