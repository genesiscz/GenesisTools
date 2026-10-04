import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { isGateOnly } from "@genesiscz/utils/ai/config/selectors";
import { resolveProviderApiKey } from "@genesiscz/utils/ai/providers/resolve";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import type { SayProvider } from "@genesiscz/utils/macos/SayConfigManager";

export type SayCredentialCheck =
    | { kind: "ok"; apiKey?: string }
    | { kind: "fallback"; reason: string; line: string }
    | { kind: "fail"; reason: string; line: string };

/**
 * Whether a cloud provider has a key to speak with, and what to do when it has none.
 *
 * The key comes from the same ladder the speech engines use (`providerApiKey`,
 * src/utils/ai/providers/resolve.ts): the provider's enabled accounts first, then
 * the variables it declares. This used to read the environment alone, so a
 * `tools say` started by Genesis.app or launchd (no shell exports) fell back to
 * macOS even when an account held the key.
 *
 * `reason` is the ladder's own error, which names the command that fixes it.
 */
export async function checkSayCredential(args: {
    provider: SayProvider;
    fallback: boolean;
}): Promise<SayCredentialCheck> {
    const { provider, fallback } = args;

    if (provider === "macos") {
        return { kind: "ok" };
    }

    try {
        await resolveProviderApiKey(provider);
        return { kind: "ok" };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.debug({ err, provider, fallback }, "[say] provider has no usable key");

        if (!fallback) {
            return { kind: "fail", reason, line: `[say] ${provider} has no usable key. ${reason}` };
        }

        return {
            kind: "fallback",
            reason,
            line: `[say] ${provider} has no usable key, falling back to macos. ${reason}`,
        };
    }
}

/** The cloud providers `tools say` can speak through with a chosen account. */
const ACCOUNT_PROVIDERS = ["xai", "openai", "elevenlabs"] as const satisfies readonly SayProvider[];

export type SayAccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

function isAccountProvider(value: string): value is SayAccountProvider {
    return (ACCOUNT_PROVIDERS as readonly string[]).includes(value);
}

/** The account `--account` named, before any key is read. */
export interface SayAccount {
    entry: AccountEntry;
    provider: SayAccountProvider;
}

export class SayAccountError extends Error {}

export interface SayAccountDeps {
    /** `AiConfigStore.account` on a read-only snapshot: id first, then a unique name. */
    lookup?: (selector: string) => Promise<AccountEntry | undefined>;
    /** A stored or opted-in key, through the credential chokepoint. */
    resolveKey?: (entry: AccountEntry) => Promise<string>;
    /** A `gate-only` account's key, through `tools ai gate` (native approval). */
    requestGate?: (entry: AccountEntry) => Promise<string>;
}

async function lookupAccount(selector: string): Promise<AccountEntry | undefined> {
    // Read-only: speaking must not migrate the AI config or rotate anything. Loaded here, not at
    // import time, so a `tools say` that names no account never pays for the AI config modules.
    const { AiConfigStore } = await import("@genesiscz/utils/ai/config/AiConfigStore");
    const store = await AiConfigStore.readOnly();
    return store.account(selector);
}

async function accountKey(entry: AccountEntry): Promise<string> {
    const [{ registerBuiltInPlugins }, { tryProviderPlugin }, { resolveCredential }] = await Promise.all([
        import("@genesiscz/utils/ai/providers/plugins"),
        import("@genesiscz/utils/ai/providers/registry"),
        import("@genesiscz/utils/ai/providers/credentials"),
    ]);
    registerBuiltInPlugins();
    const spec = tryProviderPlugin(entry.provider)?.credential ?? {
        fields: ["apiKey"],
        envKeys: [],
        required: ["apiKey"],
    };
    const resolved = await resolveCredential(entry, spec);

    if (!resolved.apiKey) {
        throw new SayAccountError(`account "${entry.name}" resolved no API key`);
    }

    return resolved.apiKey;
}

/**
 * A `gate-only` account is enabled for `tools ai gate` alone, so its key is asked for the way
 * any other app asks: a child `tools ai gate request` naming this process, which GenesisTools.app
 * approves with Touch ID (or a remembered grant). It is a child process on purpose: the gate
 * refuses a pid that is not its ancestor, and it must run under the app's identity.
 */
async function gateKey(entry: AccountEntry): Promise<string> {
    const [{ APPROVAL_TIMEOUT_MS }, { execTool }] = await Promise.all([
        import("@genesiscz/utils/ai/gate/approve"),
        import("@genesiscz/utils/cli"),
    ]);
    const result = await execTool(
        [
            "ai",
            "gate",
            "request",
            "--client",
            "say",
            "--pid",
            String(process.pid),
            "--provider",
            entry.provider,
            "--account",
            entry.id,
            "--print-token",
        ],
        { timeout: APPROVAL_TIMEOUT_MS + 30_000 }
    );

    if (!result.success || !result.stdout) {
        const reason = result.stderr.split("\n").filter(Boolean).at(-1) ?? `exit ${result.exitCode}`;
        logger.debug({ account: entry.name, exitCode: result.exitCode }, "[say] gate refused the account key");
        throw new SayAccountError(`${toolCommand("ai gate")} did not hand out the key of "${entry.name}": ${reason}`);
    }

    return result.stdout;
}

/**
 * Find the account `--account` (or the profile's `account`) names. Reads no secret: the
 * key is read later, and only when that account's provider really speaks.
 */
export async function findSayAccount(selector: string, deps: SayAccountDeps = {}): Promise<SayAccount> {
    const entry = await (deps.lookup ?? lookupAccount)(selector);

    if (!entry) {
        throw new SayAccountError(`no AI account "${selector}" (${toolCommand("ai config account list")})`);
    }

    if (!entry.enabled) {
        throw new SayAccountError(`AI account "${entry.name}" is disabled`);
    }

    if (!isAccountProvider(entry.provider)) {
        throw new SayAccountError(
            `AI account "${entry.name}" is ${entry.provider}; ${toolCommand("say")} speaks through ${ACCOUNT_PROVIDERS.join(", ")} accounts`
        );
    }

    return { entry, provider: entry.provider };
}

/** The chosen account's key: through the gate for a `gate-only` account, else the credential chokepoint. */
export async function sayAccountKey(account: SayAccount, deps: SayAccountDeps = {}): Promise<string> {
    const gated = isGateOnly(account.entry);
    logger.debug({ account: account.entry.name, provider: account.provider, gated }, "[say] resolving the account key");

    try {
        return gated
            ? await (deps.requestGate ?? gateKey)(account.entry)
            : await (deps.resolveKey ?? accountKey)(account.entry);
    } catch (err) {
        if (err instanceof SayAccountError) {
            throw err;
        }

        throw new SayAccountError(err instanceof Error ? err.message : String(err));
    }
}

/**
 * `checkSayCredential` for a chosen account: the same three outcomes, plus the key itself on
 * success, which the engine then uses instead of walking the provider's accounts.
 */
export async function checkSayAccountCredential(args: {
    account: SayAccount;
    fallback: boolean;
    deps?: SayAccountDeps;
}): Promise<SayCredentialCheck> {
    const { account, fallback } = args;

    try {
        return { kind: "ok", apiKey: await sayAccountKey(account, args.deps) };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const name = account.entry.name;

        if (!fallback) {
            return { kind: "fail", reason, line: `[say] account ${name} has no usable key. ${reason}` };
        }

        return {
            kind: "fallback",
            reason,
            line: `[say] account ${name} has no usable key, falling back to macos. ${reason}`,
        };
    }
}

/**
 * One usage row per synthesis the chosen account paid for (a cache hit pays nothing). Speech is
 * priced per character, not per token, so the row carries 0/0 tokens and the character count in
 * `meta`; no rate is invented here, so the row stays unpriced unless the catalog knows the model.
 */
export async function recordSayAccountUsage(args: {
    account: SayAccount;
    model: string | null;
    characters: number;
}): Promise<void> {
    const { recordUsage } = await import("@genesiscz/utils/ai/usage");
    await recordUsage({
        app: "say",
        accountId: args.account.entry.id,
        provider: args.account.provider,
        modelId: args.model ?? `${args.account.provider}-tts`,
        inputTokens: 0,
        outputTokens: 0,
        meta: { kind: "tts", characters: args.characters },
    });
}
