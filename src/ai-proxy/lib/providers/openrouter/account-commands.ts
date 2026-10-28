import { aiProxyCommand, HOT_RELOAD_HINT } from "@app/ai-proxy/lib/command-hints";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import type { ProviderAccountCommand } from "@app/ai-proxy/lib/providers/account-commands";
import type {
    AiProxyAccountConfig,
    AiProxyOpenRouterAccountConfig,
    AiProxyOpenRouterProviderRouting,
    AiProxyOpenRouterRoute,
} from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/** Parsed, CLI-agnostic form of the `set-routing` flags — the thin door does the flag parsing. */
export interface AccountsRoutingPatch {
    order?: string[];
    only?: string[];
    ignore?: string[];
    sort?: "price" | "throughput" | "latency";
    allowFallbacks?: boolean;
    requireParameters?: boolean;
    dataCollection?: "allow" | "deny";
    fallbackModels?: string[];
}

function hasRoutingPatch(patch: AccountsRoutingPatch): boolean {
    return Boolean(
        patch.order ||
            patch.only ||
            patch.ignore ||
            patch.sort ||
            patch.allowFallbacks !== undefined ||
            patch.requireParameters !== undefined ||
            patch.dataCollection ||
            patch.fallbackModels
    );
}

function buildProviderPatch(
    existing: AiProxyOpenRouterProviderRouting | undefined,
    patch: AccountsRoutingPatch
): AiProxyOpenRouterProviderRouting {
    return {
        ...existing,
        ...(patch.order ? { order: patch.order } : {}),
        ...(patch.only ? { only: patch.only } : {}),
        ...(patch.ignore ? { ignore: patch.ignore } : {}),
        ...(patch.sort ? { sort: patch.sort } : {}),
        ...(patch.allowFallbacks !== undefined ? { allow_fallbacks: patch.allowFallbacks } : {}),
        ...(patch.requireParameters !== undefined ? { require_parameters: patch.requireParameters } : {}),
        ...(patch.dataCollection ? { data_collection: patch.dataCollection } : {}),
    };
}

export async function runAccountsSetRouting(
    name: string,
    patch: AccountsRoutingPatch,
    options: { clear?: boolean; match?: string } = {}
): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.log.warn(`Account not found: ${name}`);
        out.log.info(aiProxyCommand(["accounts", "list"]));
        return;
    }

    if (account.provider !== "openrouter") {
        out.log.warn(`Account "${name}" is ${account.provider} — provider-routing pins are an OpenRouter feature.`);
        return;
    }

    if (options.match) {
        await applyRoutePatch({ config, account, name, match: options.match, patch, clear: options.clear });
        return;
    }

    if (options.clear) {
        if (account.openrouter) {
            delete account.openrouter.provider;
            delete account.openrouter.fallbackModels;

            if (Object.keys(account.openrouter).length === 0) {
                delete account.openrouter;
            }
        }

        await saveConfig(config);
        out.log.success(`Cleared provider routing for "${name}" — it now uses OpenRouter's own default routing.`);
        out.log.info(HOT_RELOAD_HINT);
        return;
    }

    if (!hasRoutingPatch(patch)) {
        out.log.warn("No routing fields given — nothing changed.");
        out.log.info(
            aiProxyCommand(["accounts", "set-routing", name, "--order", "Morph,DeepInfra", "--no-allow-fallbacks"])
        );
        return;
    }

    const existing: AiProxyOpenRouterAccountConfig = account.openrouter ?? {};
    const mergedProvider = buildProviderPatch(existing.provider, patch);

    account.openrouter = {
        ...existing,
        ...(Object.keys(mergedProvider).length > 0 ? { provider: mergedProvider } : {}),
        ...(patch.fallbackModels ? { fallbackModels: patch.fallbackModels } : {}),
    };

    await saveConfig(config);

    out.log.success(`Updated provider routing for "${name}".`);

    if (account.openrouter.provider) {
        out.log.info(`  provider: ${SafeJSON.stringify(account.openrouter.provider) ?? "{}"}`);
    }

    if (account.openrouter.fallbackModels) {
        out.log.info(`  fallbackModels: ${SafeJSON.stringify(account.openrouter.fallbackModels) ?? "[]"}`);
    }

    out.log.info(HOT_RELOAD_HINT);
}

/**
 * `--match` scopes the whole operation to one entry of `openrouter.routes[]`
 * instead of the account-level default — a strict pin for one model (or
 * vendor prefix) without narrowing every other model routed through the same
 * account.
 */
async function applyRoutePatch(input: {
    config: Awaited<ReturnType<typeof loadConfig>>;
    account: AiProxyAccountConfig;
    name: string;
    match: string;
    patch: AccountsRoutingPatch;
    clear?: boolean;
}): Promise<void> {
    const { config, account, name, match, patch, clear } = input;
    const routes = account.openrouter?.routes ?? [];
    const index = routes.findIndex((route) => route.match === match);

    if (clear) {
        if (index === -1) {
            out.log.warn(`No route for "${match}" on "${name}" — nothing to clear.`);
            return;
        }

        const next = routes.filter((_, i) => i !== index);
        account.openrouter = { ...account.openrouter };

        if (next.length > 0) {
            account.openrouter.routes = next;
        } else {
            delete account.openrouter.routes;
        }

        await saveConfig(config);
        out.log.success(`Cleared the "${match}" route for "${name}".`);
        out.log.info(HOT_RELOAD_HINT);
        return;
    }

    if (!hasRoutingPatch(patch)) {
        out.log.warn("No routing fields given — nothing changed.");
        out.log.info(
            aiProxyCommand([
                "accounts",
                "set-routing",
                name,
                "--match",
                match,
                "--order",
                "Morph,DeepInfra",
                "--no-allow-fallbacks",
            ])
        );
        return;
    }

    const existingRoute: AiProxyOpenRouterRoute | undefined = index === -1 ? undefined : routes[index];
    const mergedProvider = buildProviderPatch(existingRoute?.provider, patch);
    const nextRoute: AiProxyOpenRouterRoute = {
        ...existingRoute,
        match,
        ...(Object.keys(mergedProvider).length > 0 ? { provider: mergedProvider } : {}),
        ...(patch.fallbackModels ? { fallbackModels: patch.fallbackModels } : {}),
    };
    const nextRoutes =
        index === -1 ? [...routes, nextRoute] : routes.map((route, i) => (i === index ? nextRoute : route));

    account.openrouter = { ...account.openrouter, routes: nextRoutes };

    await saveConfig(config);

    out.log.success(`Updated the "${match}" route for "${name}" (${nextRoutes.length} route(s) configured).`);

    if (nextRoute.provider) {
        out.log.info(`  provider: ${SafeJSON.stringify(nextRoute.provider) ?? "{}"}`);
    }

    if (nextRoute.fallbackModels) {
        out.log.info(`  fallbackModels: ${SafeJSON.stringify(nextRoute.fallbackModels) ?? "[]"}`);
    }

    out.log.info(HOT_RELOAD_HINT);
}

function parseCsvOption(value?: string): string[] | undefined {
    if (!value) {
        return undefined;
    }

    const items = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    return items.length > 0 ? items : undefined;
}

/** The `accounts` subcommands only OpenRouter accounts take. */
export const OPENROUTER_ACCOUNT_COMMANDS: readonly ProviderAccountCommand[] = [
    {
        register: (accounts: Command) => {
            accounts
                .command("set-routing <name>")
                .description("Pin an OpenRouter account's provider routing (order/only/ignore/sort/fallbacks)")
                .option(
                    "--match <glob>",
                    "Scope to one per-model route instead of the account-level default (exact id or a trailing *)"
                )
                .option("--order <providers>", "Comma-separated provider names, most preferred first")
                .option("--only <providers>", "Comma-separated provider names — route ONLY to these")
                .option("--ignore <providers>", "Comma-separated provider names to never route to")
                .option("--sort <mode>", "price|throughput|latency", (value: string) => {
                    if (value !== "price" && value !== "throughput" && value !== "latency") {
                        throw new Error(`--sort must be price, throughput, or latency (got "${value}")`);
                    }

                    return value;
                })
                .option("--allow-fallbacks", "Allow OpenRouter to fall back beyond the pinned/allowed providers")
                .option(
                    "--no-allow-fallbacks",
                    "Refuse fallback — only the pinned/allowed providers may serve the request"
                )
                .option("--require-parameters", "Only route to providers supporting every parameter in the request")
                .option("--no-require-parameters", "Allow providers that silently drop unsupported parameters")
                .option("--data-collection <mode>", "allow|deny", (value: string) => {
                    if (value !== "allow" && value !== "deny") {
                        throw new Error(`--data-collection must be allow or deny (got "${value}")`);
                    }

                    return value;
                })
                .option(
                    "--fallback-models <ids>",
                    "Comma-separated OpenRouter model ids to try if the primary one fails"
                )
                .option("--clear", "Remove all provider-routing pins for this account")
                .action(
                    async (
                        name: string,
                        options: {
                            match?: string;
                            order?: string;
                            only?: string;
                            ignore?: string;
                            sort?: "price" | "throughput" | "latency";
                            allowFallbacks?: boolean;
                            requireParameters?: boolean;
                            dataCollection?: "allow" | "deny";
                            fallbackModels?: string;
                            clear?: boolean;
                        },
                        command: Command
                    ) => {
                        const patch: AccountsRoutingPatch = {
                            order: parseCsvOption(options.order),
                            only: parseCsvOption(options.only),
                            ignore: parseCsvOption(options.ignore),
                            sort: options.sort,
                            allowFallbacks:
                                command.getOptionValueSource("allowFallbacks") === "cli"
                                    ? options.allowFallbacks
                                    : undefined,
                            requireParameters:
                                command.getOptionValueSource("requireParameters") === "cli"
                                    ? options.requireParameters
                                    : undefined,
                            dataCollection: options.dataCollection,
                            fallbackModels: parseCsvOption(options.fallbackModels),
                        };

                        await runAccountsSetRouting(name, patch, { clear: options.clear, match: options.match });
                    }
                );
        },
    },
];
