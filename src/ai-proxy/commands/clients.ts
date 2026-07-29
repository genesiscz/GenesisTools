import { randomBytes } from "node:crypto";
import { validateClients } from "@app/ai-proxy/lib/clients";
import { loadConfigFresh, saveConfig } from "@app/ai-proxy/lib/config";
import type { AiProxyClientConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";
import { readClientLedger } from "@app/ai-proxy/lib/usage/client-ledger";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { isSecureRef, type SecretStore, secrets } from "@genesiscz/utils/security";

/** The vault address a client's key lives at. Derived from the name, so it is stable. */
export function clientKeyPath(name: string): string {
    return `ai-proxy/clients/${name}/key`;
}

/** A key column that reveals nothing: the vault path, or the first bytes of a literal. */
function describeKey(key: AiProxyClientConfig["key"]): string {
    if (isSecureRef(key)) {
        return `vault:${key.path}`;
    }

    return `${key.slice(0, 4)}…${key.slice(-4)} (plaintext — run: tools ai-proxy clients secure)`;
}

export async function clientsList(): Promise<void> {
    const config = await loadConfigFresh();
    const clients = config.clients ?? [];

    if (clients.length === 0) {
        out.log.info("No clients configured (proxyApiKey/owner only).");
        return;
    }

    out.result(
        SafeJSON.stringify(
            clients.map(({ key, ...rest }) => ({ ...rest, key: describeKey(key) })),
            null,
            2
        ) ?? "[]"
    );
}

/**
 * Move every plaintext client key into the vault, in place.
 *
 * Not done automatically on load: writing the vault needs the master key, and a
 * long-running proxy must never block a request on a keychain prompt. This is
 * the explicit, interactive moment where that cost is acceptable.
 */
export async function clientsSecure(): Promise<void> {
    const config = await loadConfigFresh();
    const clients = config.clients ?? [];
    const plaintext = clients.filter((client) => typeof client.key === "string");

    if (plaintext.length === 0) {
        out.log.success("Every client key is already a vault reference.");
        return;
    }

    let store: SecretStore;
    try {
        store = await secrets();
    } catch (err) {
        logger.error({ err }, "ai-proxy: cannot open the vault to secure client keys");
        out.log.error(`Vault unavailable: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
    }

    const next: AiProxyClientConfig[] = [];

    for (const client of clients) {
        if (typeof client.key !== "string") {
            next.push(client);
            continue;
        }

        const ref = await store.set(clientKeyPath(client.name), client.key);
        next.push({ ...client, key: ref });
        out.log.info(`${client.name} → ${ref.path}`);
    }

    await saveConfig({ ...config, clients: next });
    out.log.success(`Moved ${plaintext.length} client key(s) into the vault.`);
}

export async function clientsAdd(input: {
    name: string;
    tokenCap?: number;
    costCap?: number;
    providers?: AiProxyProviderType[];
}): Promise<void> {
    if (input.tokenCap !== undefined && (!Number.isFinite(input.tokenCap) || input.tokenCap <= 0)) {
        out.log.error("--token-cap must be a positive number");
        process.exitCode = 1;
        return;
    }

    if (input.costCap !== undefined && (!Number.isFinite(input.costCap) || input.costCap <= 0)) {
        out.log.error("--cost-cap must be a positive number");
        process.exitCode = 1;
        return;
    }

    const config = await loadConfigFresh();
    const key = randomBytes(24).toString("base64url");

    // Validate BEFORE any irreversible write. The vault write used to come
    // first, so adding a client under an EXISTING name overwrote that client's
    // live key at `ai-proxy/clients/<name>/key` and THEN failed the duplicate
    // check — the working client was locked out by a command that reported
    // failure and printed nothing.
    const client: AiProxyClientConfig = {
        name: input.name,
        key,
        ...(input.providers?.length ? { allowedProviders: input.providers } : {}),
        ...(input.tokenCap !== undefined ? { monthlyTokenCap: input.tokenCap } : {}),
        ...(input.costCap !== undefined ? { monthlyCostCapUsd: input.costCap } : {}),
    };
    const next = [...(config.clients ?? []), client];
    const problems = validateClients(next);

    if (problems.length > 0) {
        logger.error({ problems }, "ai-proxy: refusing to add client");
        out.log.error(problems.join("\n"));
        process.exitCode = 1;
        return;
    }

    // Fail CLOSED when the vault is unreachable: a billed bearer credential must
    // never land in config.json as a literal, and a transient keychain error
    // silently downgrading storage is worse than asking the caller to retry.
    try {
        const store = await secrets();
        client.key = await store.set(clientKeyPath(input.name), key);
    } catch (err) {
        logger.error({ err, client: input.name }, "ai-proxy: vault unavailable — refusing to add the client");
        out.log.error(
            "Vault unavailable — the client key was NOT stored. Make the master key reachable " +
                "(GENESIS_TOOLS_MASTER_KEY, the OS keychain, or the opt-in key file) and re-run."
        );
        process.exitCode = 1;
        return;
    }

    await saveConfig({ ...config, clients: next });
    out.log.success(`Client "${input.name}" added.`);
    out.print(key);
    out.log.info("This key is shown ONCE — hand it to the user now.");
}

export async function clientsUsage(input: { month?: string; csv?: boolean }): Promise<void> {
    const month = input.month ?? new Date().toISOString().slice(0, 7);
    const byClient = readClientLedger().months[month] ?? {};
    const rows = Object.entries(byClient).map(([client, usage]) => ({ client, month, ...usage }));

    if (input.csv) {
        const header = "client,month,requests,prompt_tokens,completion_tokens,total_tokens,cost_usd,unpriced_requests";
        const lines = rows.map(
            (row) =>
                `${row.client},${row.month},${row.requests},${row.prompt_tokens},${row.completion_tokens},${row.total_tokens},${row.cost_usd.toFixed(4)},${row.unpriced_requests}`
        );
        out.print([header, ...lines].join("\n"));
        return;
    }

    out.result(SafeJSON.stringify(rows, null, 2) ?? "[]");
}
