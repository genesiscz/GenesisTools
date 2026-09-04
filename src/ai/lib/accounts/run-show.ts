import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { tryProviderPlugin } from "@genesiscz/utils/ai/providers/registry";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { renderCliHeader, renderCliKeyRow, renderCliSection } from "@genesiscz/utils/table";
import pc from "picocolors";
import { type CredentialKind, credentialKinds } from "./credential-kinds";

export interface RunShowOptions {
    name: string;
    json?: boolean;
    tool: string;
}

export interface AccountDetail {
    id: string;
    name: string;
    provider: string;
    alias: string;
    label?: string;
    enabled: boolean;
    credentialKinds: CredentialKind[];
    identity?: { email?: string; accountUuid?: string; organizationUuid?: string; plan?: string };
    homes: Array<{ home: string; authFile?: string; boundToAccountId?: string }>;
    subscription?: { plan?: string; status?: string; checkedAt?: number };
}

/**
 * A DIAGNOSTIC. It reads stored fields and decodes what is already on disk;
 * it never polls live quota and never rotates a token.
 */
export async function runShow(opts: RunShowOptions): Promise<void> {
    registerBuiltInPlugins();

    const store = await AiConfigStore.load();
    const account = store.account(opts.name);

    if (!account) {
        out.error(pc.red(`Account "${opts.name}" not found.`));
        out.printlnErr(pc.dim(suggestCommand(opts.tool, { subcommand: ["accounts", "list"] })));
        process.exitCode = 1;
        return;
    }

    const plugin = tryProviderPlugin(account.provider);
    const features = plugin?.accounts;
    const identity = await features?.identityOf?.(account, { probe: true });
    const allHomes = (await features?.discoverHomes?.()) ?? [];

    const detail: AccountDetail = {
        id: account.id,
        name: account.name,
        provider: account.provider,
        alias: providerAliasOf(account.provider),
        label: account.label,
        enabled: account.enabled,
        credentialKinds: credentialKinds(account),
        ...(identity ? { identity } : {}),
        homes: allHomes
            .filter((home) => home.boundToAccountId === account.id)
            .map((home) => ({ home: home.home, authFile: home.authFile, boundToAccountId: home.boundToAccountId })),
        subscription: {
            plan: account.subscriptionPlan,
            status: account.subscriptionStatus,
            checkedAt: account.subscriptionCheckedAt,
        },
    };

    if (opts.json) {
        out.result(detail);
        return;
    }

    renderCliHeader(`Account ${account.name}`, `${detail.alias} · ${account.id}`);
    renderCliKeyRow("Provider", `${detail.alias} (${account.provider})`);
    renderCliKeyRow("Label", account.label ?? "—");
    renderCliKeyRow("Enabled", account.enabled ? "yes" : "no");
    renderCliKeyRow("Credentials", detail.credentialKinds.join(", ") || "none");
    renderCliKeyRow("Email", identity?.email ?? "—");
    renderCliKeyRow("Account uuid", identity?.accountUuid ?? "—");
    renderCliKeyRow("Organization", identity?.organizationUuid ?? "—");
    renderCliKeyRow("Plan", identity?.plan ?? account.subscriptionPlan ?? "—");

    if (detail.homes.length > 0) {
        renderCliSection("Homes");
        for (const home of detail.homes) {
            out.println(`  ${home.home}${home.authFile ? pc.dim(` · ${home.authFile}`) : ""}`);
        }
    }

    renderCliSection("Next");
    out.println(pc.dim(`  Live quota: ${pc.cyan("tools ai usage")} · this command never polls.`));
}
