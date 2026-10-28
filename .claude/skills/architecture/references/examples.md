# Before and after: three shapes from this repo

Each pair shows the code as it stood on 2026-10-28, what is wrong with it in terms of the checklist in
[../SKILL.md](../SKILL.md), and the shape to move to. The "after" code is a sketch. Check the current code before you
copy names from it.

## 1. Codex-only knobs under a generic config key

Before: `ClaudeSessionsConfig` in `src/ai-proxy/lib/types.ts`, reached as `AiProxyConfig.claudeSessions`.

```ts
export interface ClaudeSessionsConfig {
    /** Claude Code's compaction turn on a Codex model. */
    compaction?: {
        mode?: "native" | "summary"; // "native" is Codex's compaction_trigger
        effort?: ReasoningEffort | "session";
        words?: number;
        idle?: boolean; // Claude Code's promptCacheTtl, the same for every provider
        // Codex async_compaction:
        background?: { enabled?: boolean; startAt?: number; refreshFraction?: number; maxTailFraction?: number };
    };
    lead?: { systemNote?: SystemNoteConfig };
    /** The Codex subagents ccx defines (sol, terra, luna, ...). */
    subagents?: { systemNote?: SystemNoteConfig; skills?: { nudge?: boolean; allowed?: string[] } };
}
```

What is wrong:

- Step 1: the axis is never named. The type says "Claude sessions", and the only provider marker is a doc comment.
- Step 2: three owners share one flat object. `idle` belongs to the Claude Code harness for every provider.
  `mode: "native"` and `background` exist only for Codex. The subagent notes are Codex text.
- A Grok entry has nowhere to go, and nothing stops a Grok reader from honouring `background`.

After (2026-10-28): the harness outside, the provider inside, one type per provider. The real types are in
`src/ai-proxy/lib/types.ts`:

```ts
export interface SessionsInConfig {
    claude?: ClaudeCodeSessionsConfig;
    // Later, Claude models inside the Codex harness: codex?: CodexHarnessSessionsConfig;
}

export interface ClaudeCodeSessionsConfig {
    global?: ClaudeCodeGlobalSettings; // compaction.idle, lead.systemNote: Claude Code's own, any provider
    providers?: ClaudeCodeProviderSettings;
}

export interface ClaudeCodeProviderSettings {
    codex?: CodexInClaudeCodeSettings; // compaction { mode, effort, words, background }, subagents
    grok?: GrokInClaudeCodeSettings; // compaction { words }: Grok has no native or background compaction
}
```

Each provider block has only the keys its code reads. Grok got `words` alone, because nothing reads a Grok effort
or Grok subagents yet.

The migration (step 3) is `migrateSessionsIn` in `src/ai-proxy/lib/config-store.ts`, beside `migratePublicConfig`.
`mergeConfig` runs it on every load and every write, and leaves `claudeSessions` out of its result, so every reader
sees only the new shape and the next save drops the old key:

```ts
function migrateSessionsIn(legacy: LegacyClaudeSessionsConfig | undefined, current: SessionsInConfig | undefined) {
    const { idle, ...codexCompaction } = legacy?.compaction ?? {};
    const global = { ...(idle === undefined ? {} : { compaction: { idle } }), ...(legacy?.lead ? { lead: legacy.lead } : {}) };
    const codex = {
        ...(Object.keys(codexCompaction).length > 0 ? { compaction: codexCompaction } : {}),
        ...(legacy?.subagents ? { subagents: legacy.subagents } : {}),
    };

    if (Object.keys(global).length === 0 && Object.keys(codex).length === 0) {
        return current; // nothing old to move: no empty block in the file
    }

    // The new shape wins. The old keys only fill gaps.
    return deepMerge({ claude: { global, providers: { codex } } }, current ?? {});
}
```

Readers do not branch on the provider either. `compactionPolicy(provider, sessionsIn)` in
`src/ai-proxy/lib/sessions/settings.ts` reads one table, `COMPACTION_POLICIES`, typed by the keys of
`ClaudeCodeProviderSettings`: a provider block with no policy does not compile. The server hands `sessionsIn` to the
provider with each request (`ProviderRequestContext.sessionsIn`), so no module global holds it.

Tests (`src/ai-proxy/lib/sessions/settings.test.ts`): a fixture with only `claudeSessions` loads into `sessionsIn`;
a fixture with both keeps the `sessionsIn` values; a fixture with neither gets no block; loading the migrated result
again changes nothing; a save writes the new shape to disk.

## 2. A factory chosen by an if-chain, plus a second list of the same names

Before: `src/ai-proxy/lib/providers/registry.ts`.

```ts
export function isProviderImplemented(provider: AiProxyAccountConfig["provider"]): boolean {
    return (
        provider === "grok-subscription" ||
        provider === "github-copilot-subscription" ||
        provider === "anthropic-subscription" ||
        provider === "openai-subscription" ||
        provider === "xai-api-key" ||
        provider === "openai" ||
        provider === "openrouter"
    );
}

export async function createProvider(account: AiProxyAccountConfig): Promise<ProxyProvider> {
    if (account.provider === "grok-subscription") {
        return GrokSubscriptionProvider.create({ account });
    }

    if (account.provider === "github-copilot-subscription") {
        return GithubCopilotSubscriptionProvider.create(account);
    }

    // ...five more branches

    throw new Error(`Provider not implemented yet: ${account.provider}`);
}
```

What is wrong:

- Step 4: the same seven names live in two lists. A provider added to `createProvider` and forgotten in
  `isProviderImplemented` is treated as not implemented, with no compiler error. `src/ai-proxy/commands/usage.ts`
  holds a third copy of the list.
- The `throw` at the end hides the mistake until runtime.
- The `ProxyProvider` interface already exists, so the seam is real. Only the dispatch is wrong.

After: one table, typed by the union, read by both functions.

```ts
interface ProxyProviderDefinition {
    create(account: AiProxyAccountConfig): Promise<ProxyProvider>;
}

const PROVIDER_DEFINITIONS: Record<AiProxyProviderType, ProxyProviderDefinition> = {
    "grok-subscription": { create: (account) => GrokSubscriptionProvider.create({ account }) },
    "github-copilot-subscription": { create: (account) => GithubCopilotSubscriptionProvider.create(account) },
    "anthropic-subscription": { create: (account) => AnthropicSubscriptionProvider.create(account) },
    "openai-subscription": { create: (account) => OpenAiSubscriptionProvider.create(account) },
    "xai-api-key": { create: (account) => XaiApiKeyProvider.create(account) },
    openai: { create: (account) => OpenAiApiKeyProvider.create(account) },
    openrouter: { create: (account) => OpenRouterApiKeyProvider.create(account) },
};

/** For values read from disk: a name this build does not know is not implemented. */
export function isProviderImplemented(provider: string): provider is AiProxyProviderType {
    return Object.hasOwn(PROVIDER_DEFINITIONS, provider);
}

export function createProvider(account: AiProxyAccountConfig): Promise<ProxyProvider> {
    return PROVIDER_DEFINITIONS[account.provider].create(account);
}
```

Next, each provider-name branch outside the table becomes a member of the definition. The 2026-10-28 survey found
them in `detect-report.ts`, `catalog.ts`, `commands/usage.ts`, `account-model-ref.ts` and `account-config.ts` under
`src/ai-proxy/`: model metadata, the default billing plane, account migration, detection. Remove each file from the
ratchet list in the commit that empties it.

## 3. Provider ids that decide flags in a shared command

Before: `src/ai/commands/accounts/login.ts`. One registrar serves `tools claude login`, `tools codex login`,
`tools grok login` and the provider-neutral `login --provider`.

```ts
function bindsCredentialFiles(provider: string | undefined): boolean {
    if (!provider) {
        return true;
    }

    registerBuiltInPlugins();

    return providerPlugin(provider).credential.fields.includes("authFile");
}

// inside registerAccountLoginCommand():
if (bindsCredentialFiles(opts.provider)) {
    login
        .option("--home <dir>", "Explicit vendor home for native credential-file login")
        .option("--auth-file <file>", "Bind an existing credential file instead of running OAuth")
        .option("--import-native", "Bind the current native CLI credential file; fail if it does not exist");
}

login.addOption(
    login
        .createOption("--broker", "Codex compatibility alias for the default separate vault login")
        .hideHelp(opts.provider !== undefined && opts.provider !== "openai-sub")
);
```

What is wrong:

- Step 4: the `--broker` line compares a provider id in a provider-neutral file. That is the name branch.
- `bindsCredentialFiles` is the milder case. It asks the plugin for a fact (its credential fields), but the shared
  command still decides which flags that fact implies.
- Step 6: a new provider with a login flag of its own has to edit this shared file.

After (proposed; `AccountFeatures` in `src/utils/ai/providers/account-features.ts` has no such member yet): each
plugin declares its login flags, and the command shows what it gets.

```ts
export interface LoginFlagSpec {
    flags: string; // "--broker"
    description: string;
}

export interface AccountFeatures {
    // ...the existing members
    /** The flags this provider's login accepts beyond the shared ones. */
    loginFlags(): LoginFlagSpec[];
}

// Shared by the plugins that log in through a credential file (Codex, Grok).
export const CREDENTIAL_FILE_FLAGS: LoginFlagSpec[] = [
    { flags: "--home <dir>", description: "Explicit vendor home for native credential-file login" },
    { flags: "--auth-file <file>", description: "Bind an existing credential file instead of running OAuth" },
    { flags: "--import-native", description: "Bind the current native CLI credential file; fail if it does not exist" },
];

// The Codex plugin owns its flags:
loginFlags: () => [
    ...CREDENTIAL_FILE_FLAGS,
    { flags: "--broker", description: "Codex compatibility alias for the default separate vault login" },
],

// login.ts names no provider. A door shows its own plugin's flags. The neutral door, and any flag that another
// door must keep accepting for compatibility, declares the union of all plugins' flags and hides the ones that
// are not the door's own.
```

`runLogin` already refuses the credential-file flags for a provider that has no credential file (Anthropic logs in
through OAuth only), so the command does not need to know why a flag is missing.

## More of the same shape

The 2026-10-28 survey listed these as well. Treat them with the same steps when you touch them:

- `AiProxyConfig.codexModels` at the top level. Grok model overrides would need a sibling key, so it becomes
  `modelOverrides: { codex, grok }`.
- `AiProxyAccountConfig` is already nested per provider, which is the model to copy, but `failover`, `baseUrl`,
  `realtimeBaseUrl` and `teamId` still sit flat with a comment that names one provider.
- The session record (`src/ai-proxy/lib/sessions/records.ts`) has `codexAccount`, `claudeAccount`, `grokAccount`
  and three more parallel fields, patched over with lookup maps. The shape to move to is
  `agents: Record<SessionAgent, { proxyAccount?, login? }>`. It is saved data, so read both shapes.
- `codexBroker` travels in the shared login context. Move it into `providerOptions.codex`, or let the Codex plugin
  read its own flag.
- `SubscriptionUsageDetails` has one optional field per provider (`grok`, `copilot`, `xai`). A usage source per
  provider removes the flat union.
