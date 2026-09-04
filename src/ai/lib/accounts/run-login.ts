import { clearPollGate } from "@app/claude/lib/usage/poll-gate";
import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures, AccountFlowContext, LoginOutcome } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { clearInvalidGrant } from "@genesiscz/utils/claude/subscription-auth";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { resolveAccountsProvider } from "./select-provider";
import { writeLoginOutcome } from "./write-outcome";

export interface RunLoginOptions {
    /** Pinned by `tools claude login`; resolved from `--provider` otherwise. */
    provider?: string | true;
    name?: string;
    /** Vendor home to log into (`--home`): a codex profile dir, a grok GROK_HOME. */
    home?: string;
    /** An existing credential file to bind without running a flow (`--auth-file`). */
    authFile?: string;
    tool: string;
    subcommand?: string[];
}

export interface RunLoginResult {
    ok: boolean;
    account?: AccountEntry;
}

/**
 * The one login core. `tools claude login`, `tools codex login`, `tools grok
 * login`, `tools ai accounts login` and `tools ai-proxy accounts login codex`
 * all arrive here; only the provider differs.
 */
export async function runLogin(opts: RunLoginOptions): Promise<RunLoginResult> {
    registerBuiltInPlugins();

    const interactive = isInteractive();
    const resolved = await resolveAccountsProvider({
        raw: opts.provider,
        interactive,
        tool: opts.tool,
        subcommand: opts.subcommand,
    });

    if (resolved.status === "help") {
        out.printlnErr(resolved.help);
        process.exitCode = 1;
        return { ok: false };
    }

    if (resolved.status === "cancelled") {
        p.cancel("Cancelled");
        return { ok: false };
    }

    const plugin = resolved.plugin;
    const features = plugin.accounts;

    if (!features) {
        out.error(pc.red(`${plugin.id} has no account features.`));
        process.exitCode = 1;
        return { ok: false };
    }

    const store = await AiConfigStore.load();
    const ctx: AccountFlowContext = {
        requestedName: opts.name,
        home: opts.home,
        authFile: opts.authFile,
        interactive,
        ...(opts.name ? { account: store.account(opts.name) } : {}),
    };

    const outcome = features.login ? await features.login(ctx) : await bindExternalLogin(plugin, features, ctx, opts);

    if (!outcome) {
        process.exitCode = 1;
        return { ok: false };
    }

    const alias = providerAliasOf(plugin.id);
    const name = opts.name ?? outcome.suggestedName ?? alias;
    const existing = store.account(name);

    if (existing) {
        out.println(pc.yellow(`Updating existing account "${name}"...`));
    }

    // Only Anthropic ever made itself the default for `claude` and `ask`; adding
    // the other providers there would silently retarget every `tools ask` call.
    const anthropic = plugin.id === "anthropic-sub";

    const written = await writeLoginOutcome({
        name,
        outcome,
        interactive,
        account: existing,
        apps: anthropic ? ["claude", "ask"] : undefined,
        defaultForApps: anthropic ? ["claude", "ask"] : undefined,
    });

    if (!written) {
        process.exitCode = 1;
        return { ok: false };
    }

    if (anthropic) {
        // A fresh grant retires both cooldowns the dead one earned.
        await clearInvalidGrant(name);
        await clearPollGate(name);
    }

    out.println();
    out.println(pc.green(`✓ Account "${name}" saved (${alias}).`));

    if (outcome.identity?.email) {
        out.println(pc.dim(`  Email: ${outcome.identity.email}`));
    }

    if (written.account.label) {
        out.println(pc.dim(`  Plan: ${written.account.label}`));
    }

    if (written.defaultsSet.length > 0) {
        out.println(pc.dim(`  Default for: ${written.defaultsSet.join(", ")}`));
    }

    return { ok: true, account: written.account };
}

/**
 * Providers with no in-process flow (grok): print the vendor command, offer to
 * run it on a TTY, then bind the file it wrote. A file that is already there is
 * bound without running anything, which is what makes the non-TTY path usable.
 */
async function bindExternalLogin(
    plugin: ProviderPlugin,
    features: AccountFeatures,
    ctx: AccountFlowContext,
    opts: RunLoginOptions
): Promise<LoginOutcome | undefined> {
    if (!features.externalLogin) {
        out.error(pc.red(`${providerAliasOf(plugin.id)} has no login flow.`));
        return undefined;
    }

    const instruction = features.externalLogin(ctx);
    const envPrefix = Object.entries(instruction.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
    const commandLine = [envPrefix, ...instruction.command].filter(Boolean).join(" ");
    const alreadyThere = await Bun.file(instruction.authFile).exists();

    if (!alreadyThere) {
        out.println(pc.dim(`This provider logs in through its own CLI:`));
        out.println(`  ${pc.cyan(commandLine)}`);

        if (!ctx.interactive) {
            out.error(pc.red(`No credential at ${instruction.authFile}. Run the command above, then rerun:`));
            out.printlnErr(suggestCommand(opts.tool, { subcommand: opts.subcommand }));
            return undefined;
        }

        const run = await p.confirm({ message: "Run it now?", initialValue: true });

        if (p.isCancel(run)) {
            throw new Error("Cancelled");
        }

        if (run) {
            const proc = Bun.spawn(instruction.command, {
                stdio: ["inherit", "inherit", "inherit"],
                env: { ...process.env, ...instruction.env },
            });
            await proc.exited;
        }

        if (!(await Bun.file(instruction.authFile).exists())) {
            out.error(pc.red(`Still no credential at ${instruction.authFile} — nothing bound.`));
            return undefined;
        }
    }

    // A synthetic entry, only so `identityOf` can read the file it was pointed
    // at: there is no account yet, and inventing one before the identity is known
    // is exactly the write this flow defers to the CLI layer.
    const probe: AccountEntry = {
        id: "acc_probe",
        name: ctx.requestedName ?? providerAliasOf(plugin.id),
        provider: plugin.id,
        enabled: true,
        billing: { mode: "subscription" },
        credentials: { authFile: instruction.authFile },
        useEnvApiKey: false,
    };

    const identity = await features.identityOf?.(probe, { probe: true });

    return {
        provider: plugin.id,
        credentials: { authFile: instruction.authFile },
        ...(identity ? { identity } : {}),
        suggestedName: identity?.email?.split("@")[0]?.toLowerCase(),
    };
}
