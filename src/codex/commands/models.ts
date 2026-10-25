import { loadConfig } from "@app/ai-proxy/lib/config";
import { CodexAccountBinding } from "@genesiscz/utils/ai/openai/account-binding";
import {
    type CodexModelInfo,
    codexModelsCachePath,
    describeCodexEfforts,
    mergeCodexModelRecords,
    readCodexModelsCache,
} from "@genesiscz/utils/ai/openai/codex-models";
import {
    OPENAI_SUB_BUILTIN_ALIAS_NAMES,
    resolveOpenAiSubModel,
    tryFetchWhamModels,
    type WhamModelRecord,
} from "@genesiscz/utils/ai/openai/sub-models";
import { formatTokens } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const { log } = logger.scoped("codex-models");

interface ModelsOptions {
    account?: string;
    model?: string;
    all?: boolean;
    json?: boolean;
}

/**
 * The live list needs a token. Read-only: a listing never refreshes (a refresh token is single use), so an
 * expired login skips the live list and says so.
 */
async function liveRecords(account: string): Promise<WhamModelRecord[] | null> {
    try {
        const binding = await CodexAccountBinding.create(account, { allowRefresh: false });
        const tokens = await binding.tokens({ refresh: false });
        return await tryFetchWhamModels(tokens.accessToken, tokens.chatgptAccountId);
    } catch (err) {
        log.warn({ err, account }, "codex models: live list unavailable for this account");
        out.log.warn(`Live model list unavailable for ${account}; showing the CLI cache and the static table.`);
        return null;
    }
}

function aliasesFor(slug: string): string[] {
    return OPENAI_SUB_BUILTIN_ALIAS_NAMES.filter((alias) => resolveOpenAiSubModel(alias) === slug);
}

function sourceSummary(info: CodexModelInfo): string {
    const counts = new Map<string, number>();

    for (const source of Object.values(info.sources)) {
        counts.set(source, (counts.get(source) ?? 0) + 1);
    }

    return [...counts.entries()].map(([source, count]) => `${source} ${count}`).join(", ");
}

function printDetail(info: CodexModelInfo): void {
    renderCliHeader(info.slug, `${info.displayName}; aliases: ${aliasesFor(info.slug).join(", ") || "none"}`);
    const table = createBoxTable(["FIELD", "VALUE", "SOURCE"]);
    const row = (field: string, value: unknown, sourceKey = field) => {
        table.push([field, value === undefined ? pc.dim("—") : String(value), info.sources[sourceKey] ?? pc.dim("—")]);
    };

    row("window", info.window);
    row("maxContextWindow", info.maxContextWindow);
    row("usablePercent", `${info.usablePercent}% = ${info.usableTokens}`);
    row("compactPercent", `${info.compactPercent}% = ${info.compactTokens}`);
    row("efforts", describeCodexEfforts(info));
    row("defaultEffort", info.defaultEffort);
    row("multiAgentReasoningEffort", info.multiAgentReasoningEffort);
    row("useResponsesLite", info.useResponsesLite);
    row("compHash", info.compHash);
    row("supportsSearchTool", info.supportsSearchTool);
    row("webSearchToolType", info.webSearchToolType);
    row("defaultReasoningSummary", info.defaultReasoningSummary);
    row("supportsReasoningSummaryParameter", info.supportsReasoningSummaryParameter);
    row("inputModalities", info.inputModalities?.join(", "));
    out.println(table.toString());
}

export function registerModelsCommand(program: Command): void {
    program
        .command("models")
        .description(
            "Codex model catalog: window, usable and compact percents, efforts (ultra mapping), Lite, comp_hash, search; each field with its source"
        )
        .option("--account <name>", "Also read the live list with this ChatGPT login (read-only, never refreshes)")
        .option("--model <id>", "One model, every field with its source (a slug or an alias such as sol, sol6)")
        .option("--all", "Include models the backend hides")
        .option("--json", "Machine-readable output")
        .action(async (options: ModelsOptions) => {
            const config = await loadConfig();
            const live = options.account ? await liveRecords(options.account) : null;
            const cachePath = codexModelsCachePath();
            const catalog = mergeCodexModelRecords({
                live,
                cache: readCodexModelsCache(cachePath),
                overrides: config.codexModels,
            });
            log.debug(
                { account: options.account, live: live?.length ?? 0, cachePath, models: catalog.size },
                "codex models: catalog merged"
            );

            if (options.model) {
                const slug = resolveOpenAiSubModel(options.model);
                const info = catalog.get(slug);

                if (!info) {
                    throw new Error(`No Codex model "${options.model}". Known: ${[...catalog.keys()].join(", ")}`);
                }

                if (options.json) {
                    out.result(SafeJSON.stringify({ ...info, aliases: aliasesFor(slug) }, null, 2));
                    return;
                }

                printDetail(info);
                return;
            }

            const models = [...catalog.values()].filter((info) => options.all || info.visibility === "list");

            if (options.json) {
                out.result(
                    SafeJSON.stringify(
                        models.map((info) => ({ ...info, aliases: aliasesFor(info.slug) })),
                        null,
                        2
                    )
                );
                return;
            }

            renderCliHeader(
                "Codex models",
                `live: ${live ? `${live.length} from ${options.account}` : "not read"} · cache: ${cachePath}`
            );
            const table = createBoxTable([
                "MODEL",
                "ALIASES",
                "WINDOW",
                "USABLE",
                "COMPACT",
                "EFFORTS",
                "DEFAULT",
                "SOURCES",
            ]);

            for (const info of models) {
                table.push([
                    pc.white(info.slug),
                    aliasesFor(info.slug).join(", "),
                    formatTokens(info.window),
                    `${info.usablePercent}% ${formatTokens(info.usableTokens)}`,
                    `${info.compactPercent}% ${formatTokens(info.compactTokens)}`,
                    describeCodexEfforts(info),
                    info.defaultEffort ?? "",
                    sourceSummary(info),
                ]);
            }

            out.println(table.toString());
            renderCliSection("Sources");
            out.println(
                "live = WHAM /models (--account), cache = the Codex CLI's models_cache.json, static = the built-in table, default = codex-rs rule, override = ai-proxy config codexModels.<slug>"
            );
        });
}
