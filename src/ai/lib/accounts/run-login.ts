import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type {
    AccountFeatures,
    AccountFlowContext,
    ExternalLoginInstruction,
    LoginOutcome,
} from "@genesiscz/utils/ai/providers/account-features";
import { accountFieldsFrom } from "@genesiscz/utils/ai/providers/account-fields";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { clearPollGate } from "@genesiscz/utils/ai/usage-poll/poll-gate";
import { clearInvalidGrant } from "@genesiscz/utils/claude/subscription-auth";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { expandPath } from "@genesiscz/utils/paths";
import pc from "picocolors";
import { resolveAccountsProvider } from "./select-provider";
import { writeLoginOutcome } from "./write-outcome";

/**
 * The two side effects of the external flow, behind one seam so a test can drive
 * the error paths without spawning a vendor CLI or blocking on a TTY prompt.
 * Absent, `defaultExternalRunner` does the real thing.
 */
export interface ExternalLoginRunner {
    /** Answers "Run it now?" once the command has been printed. */
    confirm(instruction: ExternalLoginInstruction): Promise<boolean>;
    /** Runs the vendor command and resolves its exit code. */
    run(instruction: ExternalLoginInstruction): Promise<number>;
}

const defaultExternalRunner: ExternalLoginRunner = {
    async confirm() {
        const answer = await p.confirm({ message: "Run it now?", initialValue: true });

        // Ctrl-C is a decline, not a crash: throwing here escaped `runLogin`'s
        // own `!outcome` path and surfaced as a top-level error. Returning false
        // routes it through the declined branch, which prints where to run the
        // command by hand and still exits 1 (PR #360 review t5).
        if (p.isCancel(answer)) {
            return false;
        }

        return answer;
    },

    async run(instruction) {
        const proc = Bun.spawn(instruction.command, {
            stdio: ["inherit", "inherit", "inherit"],
            env: { ...process.env, ...instruction.env },
        });

        return await proc.exited;
    },
};

export interface RunLoginOptions {
    codexBroker?: boolean;
    /** Bind the provider's current native credential file without starting OAuth. */
    importNative?: boolean;
    /** Pinned by `tools claude login`; resolved from `--provider` otherwise. */
    provider?: string | true;
    name?: string;
    /** Vendor home to log into (`--home`): a codex profile dir, a grok GROK_HOME. */
    home?: string;
    /** An existing credential file to bind without running a flow (`--auth-file`). */
    authFile?: string;
    tool: string;
    subcommand?: string[];
    /**
     * Ask what to call the account once the flow has proved an identity, the way
     * the `tools claude config` accounts menu always did. The top-level `login`
     * commands derive the name silently and leave this unset.
     */
    promptName?: boolean;
    /** UI boundary for callers providing their own OAuth interaction. */
    authorizationInteraction?: AccountFlowContext["authorizationInteraction"];
    /** Injected by tests only; production leaves it unset. */
    externalRunner?: ExternalLoginRunner;
}

export interface RunLoginResult {
    ok: boolean;
    cancelled?: boolean;
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

    const fileOptions = [
        opts.authFile !== undefined ? "--auth-file" : undefined,
        opts.home !== undefined ? "--home" : undefined,
    ].filter((option) => option !== undefined);

    if (fileOptions.length > 0 && !plugin.credential.fields.includes("authFile")) {
        out.error(
            pc.red(
                `${providerAliasOf(plugin.id)} does not support ${fileOptions.join(" or ")}: this provider cannot bind credential files.`
            )
        );
        process.exitCode = 1;
        return { ok: false };
    }

    if (
        (opts.importNative && (fileOptions.length > 0 || opts.codexBroker)) ||
        (opts.codexBroker && fileOptions.length > 0)
    ) {
        out.error(
            pc.red(
                "Choose one login mode: default vault login (--broker), --import-native, or explicit --home/--auth-file."
            )
        );
        process.exitCode = 1;
        return { ok: false };
    }

    let importedAuthFile: string | undefined;

    if (opts.importNative) {
        if (!features.nativeAuthFile) {
            out.error(pc.red(`${providerAliasOf(plugin.id)} does not support --import-native.`));
            process.exitCode = 1;
            return { ok: false };
        }

        importedAuthFile = expandPath(features.nativeAuthFile());

        if (!(await Bun.file(importedAuthFile).exists())) {
            out.error(
                pc.red(`No native credential at ${importedAuthFile}. Log in with the native CLI before importing.`)
            );
            process.exitCode = 1;
            return { ok: false };
        }
    }

    const store = await AiConfigStore.load();
    // Absolute BEFORE anything reads them. The path a flow settles on is written
    // to the account and resolved again later from whatever directory the tool
    // happens to run in, so `--auth-file ./profile/auth.json` used to persist a
    // reference that only worked from the directory it was typed in, and
    // `--home ./profile` derived one the same way (PR #360 review r2 t1). Every
    // consumer below reads `ctx`, so this is the one place that has to normalize.
    const ctx: AccountFlowContext = {
        requestedName: opts.name,
        authorizationInteraction: opts.authorizationInteraction,
        codexBroker: opts.codexBroker,
        home: opts.home === undefined ? undefined : expandPath(opts.home),
        authFile: importedAuthFile ?? (opts.authFile === undefined ? undefined : expandPath(opts.authFile)),
        interactive,
        ...(opts.name ? { account: store.account(opts.name) } : {}),
    };

    let outcome: LoginOutcome | undefined;
    try {
        outcome = await resolveLoginOutcome(plugin, features, ctx, opts);
    } catch (error) {
        if (error instanceof Error && (error.message === "Cancelled" || error.name === "ExitPromptError")) {
            p.cancel("Login cancelled — nothing written.");
            return { ok: false, cancelled: true };
        }

        throw error;
    }

    if (!outcome) {
        process.exitCode = 1;
        return { ok: false };
    }

    const alias = providerAliasOf(plugin.id);
    const suggested = opts.name ?? outcome.suggestedName ?? alias;
    // Re-read: the browser round-trip takes minutes, and another terminal may
    // have added an account under the name this one is about to claim.
    const fresh = await AiConfigStore.load();
    const name =
        opts.name === undefined && opts.promptName === true && interactive
            ? await promptAccountName(fresh, suggested)
            : suggested;

    if (name === null) {
        p.cancel("Cancelled — nothing written.");
        return { ok: false };
    }

    const existing = fresh.account(name);

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
        // A name nobody typed or confirmed: `--name` is explicit, and the prompt
        // above already asked before reusing an existing one.
        autoNamed: opts.name === undefined && !(opts.promptName === true && interactive),
        apps: anthropic ? ["claude", "ask"] : undefined,
        defaultForApps: anthropic ? ["claude", "ask"] : undefined,
    });

    if (!written) {
        process.exitCode = 1;
        return { ok: false };
    }

    if (anthropic) {
        // A fresh grant retires the invalid-grant cooldown the dead one earned.
        await clearInvalidGrant(name);
    }

    // Every provider, not just anthropic: a login has just repaired this account, so the
    // next round must poll it instead of serving out a backoff earned while it was dead.
    // Codex and grok also have the credential-stamp release inside the gate, but that only
    // fires once a poll stats the new file; clearing here is immediate and costs one write.
    await clearPollGate(plugin.id, name);

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
 * What to call the account, when the caller wants to be asked.
 *
 * A straight copy of the prompt the `tools claude config` accounts menu used
 * before the flows moved here: the suggested name is a placeholder rather than a
 * default, and an existing name needs a confirmation before it is overwritten.
 * Returns null when the user aborted.
 */
async function promptAccountName(store: AiConfigStore, suggested: string): Promise<string | null> {
    const first = await p.text({
        message: "Name for this account:",
        placeholder: suggested,
        defaultValue: suggested,
        validate: (value) => {
            if (!value?.trim() && !suggested) {
                return "Name is required";
            }
        },
    });

    if (p.isCancel(first)) {
        return null;
    }

    const name = (first as string).trim() || suggested;

    if (!store.account(name)) {
        return name;
    }

    const overwrite = await p.confirm({
        message: `Account "${name}" already exists. Overwrite?`,
        initialValue: false,
    });

    if (p.isCancel(overwrite)) {
        return null;
    }

    if (overwrite) {
        return name;
    }

    const other = await p.text({
        message: "Enter a different name:",
        validate: (value) => {
            if (!value?.trim()) {
                return "Name is required";
            }

            if (store.account(value.trim())) {
                return `Account "${value.trim()}" already exists`;
            }
        },
    });

    if (p.isCancel(other)) {
        return null;
    }

    return (other as string).trim();
}

/**
 * Which flow this login runs.
 *
 * `--auth-file` is documented on every door as "bind an existing credential file
 * INSTEAD of running a flow", but a provider that HAS an in-process flow ran it
 * anyway: `tools codex login --auth-file x` demanded a TTY, performed OAuth and
 * then overwrote the very file it had been asked to import, so the scripted form
 * failed and the interactive form destroyed its own input (PR #360 review t2).
 *
 * A file already on disk is bound as it is for providers supporting authFile. A missing one
 * still falls through to the provider's flow, which is how `tools grok login
 * --auth-file <new path>` creates one.
 */
async function resolveLoginOutcome(
    plugin: ProviderPlugin,
    features: AccountFeatures,
    ctx: AccountFlowContext,
    opts: RunLoginOptions
): Promise<LoginOutcome | undefined> {
    if (ctx.authFile !== undefined && (await Bun.file(ctx.authFile).exists())) {
        return bindAuthFile(plugin, features, ctx, ctx.authFile);
    }

    if (opts.importNative) {
        out.error(pc.red("The native credential file disappeared before it could be bound. Retry the import."));
        return undefined;
    }

    return features.login ? await features.login(ctx) : await bindExternalLogin(plugin, features, ctx, opts);
}

/**
 * Turn a credential file that is already on disk into a login outcome: read whose
 * it is, and write nothing.
 *
 * The account entry here is synthetic, only so `identityOf` has something to read
 * the path out of. There is no account yet, and inventing one before the identity
 * is known is exactly the write this flow defers to the CLI layer.
 */
async function bindAuthFile(
    plugin: ProviderPlugin,
    features: AccountFeatures,
    ctx: AccountFlowContext,
    authFile: string
): Promise<LoginOutcome> {
    const probe: AccountEntry = {
        id: "acc_probe",
        name: ctx.requestedName ?? providerAliasOf(plugin.id),
        provider: plugin.id,
        enabled: true,
        billing: { mode: "subscription" },
        credentials: { authFile },
        useEnvApiKey: false,
    };

    const identity = await features.identityOf?.(probe, { probe: true });

    return {
        provider: plugin.id,
        credentials: { authFile },
        ...(identity ? { identity, accountFields: accountFieldsFrom(identity) } : {}),
        suggestedName: identity?.email?.split("@")[0]?.toLowerCase(),
    };
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

        const runner = opts.externalRunner ?? defaultExternalRunner;

        // Declining is its own outcome, not a missing file: the user chose to run
        // the command elsewhere, so the reply is where to run it, not a complaint
        // that it did not appear.
        if (!(await runner.confirm(instruction))) {
            out.error(pc.red(`Declined — nothing bound. Run it yourself, then rerun:`));
            out.printlnErr(`  ${commandLine}`);
            out.printlnErr(suggestCommand(opts.tool, { subcommand: opts.subcommand }));
            return undefined;
        }

        const exitCode = await runner.run(instruction);

        // A vendor CLI that failed loudly must not be reported as a missing file,
        // and whatever it left behind on the way out is not a credential we trust.
        if (exitCode !== 0) {
            out.error(
                pc.red(
                    `\`${commandLine}\` exited ${exitCode} — nothing bound. It should have written ${instruction.authFile}.`
                )
            );
            return undefined;
        }

        if (!(await Bun.file(instruction.authFile).exists())) {
            out.error(pc.red(`Still no credential at ${instruction.authFile} — nothing bound.`));
            return undefined;
        }
    }

    return bindAuthFile(plugin, features, ctx, instruction.authFile);
}
