import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { runAiProxyUp } from "@app/ai-proxy/lib/lifecycle";
import { REASONING_EFFORT_SUFFIXES } from "@app/ai-proxy/lib/resolve-model";
import type { AiProxyConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { ensureOnboardingSkippedForOAuthToken } from "@app/claude/lib/launch-env";
import * as p from "@clack/prompts";
import { findClaudeCommand } from "@genesiscz/utils/claude";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { shellSingleQuote } from "../lib/shell-quote";

interface RunOptions {
    model?: string;
    effort?: string;
    list?: boolean;
    start?: boolean;
}

/** What the proxy's `:<effort>` suffix accepts — the proxy's own list, so the two cannot drift. */
const EFFORTS: readonly string[] = REASONING_EFFORT_SUFFIXES;

/**
 * Validated before anything else runs. Checking it after `pickModel()` made the
 * user answer an interactive picker before learning the flag was misspelled, and
 * `--list` skipped the check entirely.
 */
export function effortError(effort: string | undefined): string | undefined {
    if (!effort || EFFORTS.includes(effort)) {
        return undefined;
    }

    return `Unknown effort "${effort}". Use one of: ${EFFORTS.join(", ")}`;
}

/**
 * `tools claude run` points Claude Code at ai-proxy instead of api.anthropic.com,
 * so any proxied model (Grok, Copilot, OpenRouter, xAI) drives a normal Claude
 * Code session. The proxy answers /v1/messages natively — see
 * src/ai-proxy/lib/anthropic-messages.ts for the translation.
 */

/** Every whitespace-separated token must appear, so "grok 4.6" matches grok-4.6. */
function matchesSpec(haystack: string, spec: string): boolean {
    const target = haystack.toLowerCase();

    return spec
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .every((token) => target.includes(token));
}

/**
 * Narrow the proxy catalog to what the user asked for.
 *
 * `target` is an account/provider prefix (`martin/grok`) or a full proxy id;
 * `modelSpec` is a substring filter applied inside it (`4.6`, `sonnet`).
 */
export function selectProxyModels(
    catalog: ProxyModelMeta[],
    { target, modelSpec }: { target?: string; modelSpec?: string }
): ProxyModelMeta[] {
    let candidates = catalog;

    if (target) {
        const trimmed = target.replace(/\/+$/, "");
        const exact = catalog.filter((entry) => entry.proxyId === trimmed);

        if (exact.length > 0) {
            candidates = exact;
        } else {
            const prefixed = catalog.filter((entry) => entry.proxyId.startsWith(`${trimmed}/`));
            candidates =
                prefixed.length > 0
                    ? prefixed
                    : catalog.filter((entry) => matchesSpec(entry.proxyId, trimmed.replace(/\//g, " ")));
        }
    }

    if (modelSpec) {
        candidates = candidates.filter((entry) => matchesSpec(entry.proxyId, modelSpec));
    }

    return candidates;
}

/**
 * A catalog miss is not the same as "not callable". The proxy advertises a
 * CURATED list, and `resolveModel` routes any `<account>/<provider>/<model>` id
 * whose account exists — that is how `martin/grok/grok-4.6` answered chat while
 * `ai-proxy models` still hid it. So a full id aimed at a known account is
 * passed through instead of refused.
 *
 * Requires an existing account/provider prefix on purpose: a typo in the account
 * name should still fail here rather than become an upstream 404.
 */
export function unlistedProxyModel(catalog: ProxyModelMeta[], target: string): ProxyModelMeta | null {
    const trimmed = target.replace(/\/+$/, "");
    const [accountName, providerSlug, ...rest] = trimmed.split("/");
    const upstreamId = rest.join("/");

    if (!accountName || !providerSlug || !upstreamId) {
        return null;
    }

    const sibling = catalog.find((entry) => entry.accountName === accountName && entry.providerSlug === providerSlug);

    if (!sibling) {
        return null;
    }

    // Account-level fields (provider, baseUrl, billingPlane) carry over; per-model
    // ones do NOT. Inheriting a sibling's contextWindow would print a confident
    // "500k ctx" for a model nobody measured.
    return {
        ...sibling,
        proxyId: trimmed,
        upstreamId,
        source: "static",
        probeStatus: undefined,
        contextWindow: undefined,
        inputModalities: undefined,
        supportsTools: undefined,
        supportsParallelToolCalls: undefined,
        agentType: undefined,
        apiBackend: undefined,
        description: undefined,
    };
}

function describe(entry: ProxyModelMeta): string {
    const bits = [
        entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}k ctx` : "",
        entry.thinking && entry.thinking !== "none" ? `thinking: ${entry.thinking}` : "",
        entry.supportsTools === false ? pc.red("no tools") : "",
        entry.billingPlane,
    ].filter(Boolean);

    return bits.join(" · ");
}

async function pickModel(candidates: ProxyModelMeta[], hint: string): Promise<ProxyModelMeta> {
    if (candidates.length === 1) {
        return candidates[0];
    }

    if (!isInteractive()) {
        out.error(pc.red(`${candidates.length} models match ${hint} — narrow it down.`));

        for (const entry of candidates.slice(0, 20)) {
            out.printlnErr(`  ${entry.proxyId}`);
        }

        await out.flush();
        process.exit(1);
    }

    const choice = await p.select({
        message: `Which model? (${candidates.length} match ${hint})`,
        options: candidates.map((entry) => ({
            value: entry.proxyId,
            label: entry.proxyId,
            hint: describe(entry),
        })),
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled.");
        process.exit(0);
    }

    const picked = candidates.find((entry) => entry.proxyId === choice);

    if (!picked) {
        out.error(pc.red("Selection did not match any catalog entry."));
        await out.flush();
        process.exit(1);
    }

    return picked;
}

async function ensureProxyUp(config: AiProxyConfig, autoStart: boolean): Promise<void> {
    const healthUrl = `http://${config.listen.host}:${config.listen.port}/health`;

    try {
        const probe = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });

        if (probe.ok) {
            logger.debug({ healthUrl }, "[run] ai-proxy already healthy");
            return;
        }
    } catch (error) {
        logger.debug({ error, healthUrl }, "[run] ai-proxy health probe failed — will start it");
    }

    if (!autoStart) {
        out.error(pc.red(`ai-proxy is not answering on ${healthUrl}.`));
        out.printlnErr(suggestCommand("tools ai-proxy", { replaceCommand: ["up"] }));
        await out.flush();
        process.exit(1);
    }

    const result = await runAiProxyUp();
    logger.info({ started: result.started, pid: result.pid }, "[run] ai-proxy readiness");
}

export async function runProxySession(
    target: string | undefined,
    opts: RunOptions,
    passthrough: string[]
): Promise<void> {
    const badEffort = effortError(opts.effort);

    if (badEffort) {
        out.error(pc.red(badEffort));
        await out.flush();
        process.exit(1);
    }

    const config = await loadConfigFresh();

    if (!config.proxyApiKey) {
        out.error(pc.red("This ai-proxy has no proxyApiKey yet."));
        out.printlnErr(suggestCommand("tools ai-proxy", { replaceCommand: ["config", "init"] }));
        await out.flush();
        process.exit(1);
    }

    const catalog = await buildProxyModelCatalog(config.accounts);
    let candidates = selectProxyModels(catalog, { target, modelSpec: opts.model });
    const hint = [target, opts.model].filter(Boolean).join(" + ") || "anything";

    let unlisted: ProxyModelMeta | null = null;

    if (candidates.length === 0 && target && !opts.model) {
        unlisted = unlistedProxyModel(catalog, target);

        if (unlisted) {
            logger.info({ proxyId: unlisted.proxyId }, "[run] target is not in the catalog but its account is");
            candidates = [unlisted];
        }
    }

    if (opts.list) {
        for (const entry of candidates) {
            out.println(`${entry.proxyId}  ${pc.dim(describe(entry))}`);
        }

        return;
    }

    if (candidates.length === 0) {
        out.error(pc.red(`No proxy model matches ${hint}.`));

        // The same spec usually IS served, just by another account — say so instead
        // of leaving the user to re-run `ai-proxy models` and diff by eye.
        const elsewhere = opts.model ? selectProxyModels(catalog, { modelSpec: opts.model }) : [];

        if (elsewhere.length > 0) {
            out.printlnErr(pc.dim("Served by other accounts:"));

            for (const entry of elsewhere.slice(0, 10)) {
                out.printlnErr(`  ${entry.proxyId}`);
            }
        } else {
            out.printlnErr(suggestCommand("tools ai-proxy", { replaceCommand: ["models"] }));
        }

        await out.flush();
        process.exit(1);
    }

    const picked = await pickModel(candidates, hint);

    // The proxy reads effort off the model id, so pinning one is a suffix.
    const model = opts.effort ? { ...picked, proxyId: `${picked.proxyId}:${opts.effort}` } : picked;

    if (unlisted) {
        out.log.warn(
            `${model.proxyId} is not in the proxy catalog — launching it anyway. An unknown id 404s upstream.`
        );
    }

    if (model.supportsTools === false) {
        out.log.warn(`${model.proxyId} does not advertise tool calling — Claude Code will not be able to edit files.`);
    }

    await ensureProxyUp(config, opts.start !== false);
    await ensureOnboardingSkippedForOAuthToken();

    // Claude Code appends /v1/messages itself, so the base URL is the origin.
    const baseUrl = `http://${config.listen.host}:${config.listen.port}`;

    const launchEnv: Record<string, string | undefined> = {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: config.proxyApiKey,
        ANTHROPIC_MODEL: model.proxyId,
        // Background work (titles, summaries) uses the small/fast slot; without it
        // Claude Code asks the proxy for a haiku id that no account serves.
        ANTHROPIC_SMALL_FAST_MODEL: model.proxyId,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model.proxyId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model.proxyId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model.proxyId,
        // Put the proxied model in the /model picker so switching away and back works.
        ANTHROPIC_CUSTOM_MODEL_OPTION: model.proxyId,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: model.upstreamId,
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: `${model.providerSlug} via ai-proxy (${model.accountName})`,
        TOOLS_CLAUDE_ACCOUNT: `proxy:${model.accountName}/${model.providerSlug}`,
        // Claude Code cannot learn a proxied model's window, so it falls back to a
        // default and shows e.g. 155k for a 500k model — which then drives
        // auto-compact to fire far too early. Its own guidance is "set
        // CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window", and the catalog
        // already knows it.
        ...(model.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.contextWindow) } : {}),
    };

    // A first-party OAuth token in the environment outranks ANTHROPIC_AUTH_TOKEN and
    // would silently bill the real Anthropic account instead of reaching the proxy.
    delete launchEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete launchEnv.ANTHROPIC_API_KEY;
    delete launchEnv.CLAUDE_CODE_SUBSCRIPTION_TYPE;
    delete launchEnv.ANTHROPIC_DEFAULT_FABLE_MODEL;

    const shell = env.paths.getShell("/bin/sh");
    const cmd = await findClaudeCommand();
    const suffix = passthrough.length > 0 ? ` ${passthrough.map(shellSingleQuote).join(" ")}` : "";

    // A session silently running at the model's default effort looks identical to
    // one running at the effort you asked for, so say which it is.
    const effortNote = opts.effort ? `effort ${opts.effort}` : "effort: model default";
    const ctxNote = model.contextWindow ? `, ${Math.round(model.contextWindow / 1000)}k ctx` : "";
    out.printlnErr(
        pc.dim(`Starting Claude Code on ${pc.magenta(model.proxyId)} (${effortNote}${ctxNote}) via ${baseUrl}...`)
    );
    logger.info({ cmd, model: model.proxyId, baseUrl, passthrough }, "[run] spawning claude against ai-proxy");

    const proc = Bun.spawn({
        cmd: [shell, "-ic", `exec ${cmd}${suffix}`],
        stdio: ["inherit", "inherit", "inherit"],
        env: launchEnv,
    });

    process.exit(await proc.exited);
}

export function registerRunCommand(program: Command): void {
    program
        .command("proxy [target]")
        .description(
            "Launch Claude Code against a model served by ai-proxy (Grok, Copilot, OpenRouter, xAI). " +
                "[target] is an <account>/<provider> prefix or a full proxy model id. " +
                "`claude run <account>/<provider>` is the same thing. " +
                "Args after -- are passed through to claude."
        )
        .allowExcessArguments(true)
        .option("-m, --model <spec>", "Model filter inside the target (e.g. 4.6, sonnet, composer)")
        .option(
            "-e, --effort <level>",
            `Reasoning effort to pin: ${EFFORTS.join(" | ")} (appends the :<effort> suffix). ` +
                "Claude Code's own /effort command also works and now reaches the upstream."
        )
        .option("--list", "List the matching proxy models and exit")
        .option("--no-start", "Fail if ai-proxy is not already running instead of starting it")
        .action(async (target: string | undefined, opts: RunOptions, command: Command) => {
            const operands = command.args;
            let targetArg = target;
            let passthrough = operands.slice(1);

            if (targetArg?.startsWith("-")) {
                targetArg = undefined;
                passthrough = operands;
            }

            await runProxySession(targetArg, opts, passthrough);
        });
}
