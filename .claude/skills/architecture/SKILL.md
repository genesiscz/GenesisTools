---
name: architecture
description: >-
  GenesisTools structure rules for the moment you decide a shape: a key in a config type or a saved JSON
  file, a CLI flag set, a branch on a provider, harness, account or platform name (`=== "codex"`,
  `case "grok":`, `provider !== "openai-sub"`), or a second implementation (a provider, agent, store or
  reader). It makes you name the axis the change varies on, nest by it, migrate saved shapes in their loader,
  and put per-provider behaviour behind one interface and an exhaustive table instead of if-chains, without
  abstracting too early. Use it before adding any of these, above all in config loaders, provider registries,
  login and launch commands, src/ai-proxy, src/utils/ai/providers and src/utils/agent-sessions, and whenever
  someone asks where a setting goes, how to add a provider or agent ("add Grok", "Claude inside Codex", "a
  fourth agent"), classes or functions, or why a change is so expensive, even if they never say
  architecture. It also routes to balanced-coupling, review and api-and-interface-design.
---

# Architecture: name the axis, then shape the code by it

GenesisTools drives several coding agents (Claude Code, Codex, Grok, and more to come) against several model
providers and accounts. Most structural debt here has one shape: a fact that belongs to one provider or harness
was written into a shared place. Codex-only compaction knobs sat flat in `claudeSessions.compaction`, marked only
by a comment that said "Codex". About 150 lines pick behaviour with `kind === "codex"` at the call site. Each one
makes the next provider edit shared files and guess which keys apply to it.

Run this checklist at the moment you create such a shape. It is short on purpose. For a full design review, load
the skills named at the end.

## When to run it

Before you write any of these:

- a key in a config type, or a field of anything saved to disk (`~/.genesis-tools/**` JSON, session records,
  `*.meta.json`, a SQLite column);
- a CLI flag, above all one that only some providers accept;
- a branch on a name: `=== "codex"`, `case "grok":`, `provider !== "openai-sub"`, `platform === "win32"`;
- a second implementation of something that exists once (a provider, a store, a reader, a launcher);
- a module or an exported function that other tools will call.

## 1. Name the axis and its owner

Write one sentence: what does the new thing vary by, and which code owns that variation? The axes here:

- **Harness**: the agent program the session runs in (`claude`, `codex`, `grok`). Code: `AgentKind`,
  `SessionAgent`, `x.harness`.
- **Provider**: whose models and account answer the request (`openai-sub` for Codex, `grok-sub`,
  `anthropic-sub`, `openrouter`, ...). Code: `ProviderPlugin.id`, `AiProxyAccountConfig.provider`.
- **Account**: one login of a provider (immutable `id`, renameable `name`).
- **Platform**: `darwin`, `linux`, `win32`.
- **Package**: the shared `@genesiscz/utils` (`src/utils/`) or one tool (`src/<tool>/`).

Then decide:

- The same for every member of the axis: it is global. True for one member: it belongs to that member.
- If your doc comment has to name a provider or harness ("on a Codex model"), the key is in the wrong place. The
  comment is doing the job that the structure should do.
- Ask how often the axis gains a member. Harness and provider gain one every few months here, so treat them as
  volatile. A shortcut on a stable axis costs little. On a volatile axis it costs again with every new member.

## 2. Nest by the axis

One more level of nesting is cheaper than a flat key with a comment. A nested key shows where the next member
goes. A flat key hides it.

The agreed shape for session settings (2026-10-28, it replaces `claudeSessions`):

```jsonc
"sessionsIn": {
    "claude": {                          // harness: where the session runs
        "global": { "compaction": { "idle": true }, "lead": { "systemNote": {} } },
        "providers": {                   // provider: whose models answer it
            "codex": { "compaction": { "mode": "native", "background": { "enabled": true } }, "subagents": {} },
            "grok": { "compaction": { "words": 3000 } }
        }
    }
}
```

The harness is the outer key because the harness defines the session: its compaction turn, its subagents, its
cache lifetime. The provider only answers. Claude Code on Codex models is `sessionsIn.claude.providers.codex`, and
a later "Claude inside Codex" is `sessionsIn.codex.providers.claude`, with no rename.

- Give each member its own type (`CodexInClaudeCodeSettings`, `GrokInClaudeCodeSettings` in
  `src/ai-proxy/lib/types.ts`). Grok's type has no `background`, so nobody can set it for Grok by mistake.
- Give a member only the keys its code reads. A key with no reader is dead config that looks like a working
  setting. Grok got `words` and nothing else, because nothing reads a Grok effort yet.
- A key that means the same everywhere but works for one member today (`words`, `effort`) stays under each member
  that supports it. Move it to `global` only when every member honours it.
- A value that code builds and passes around (an event, a result, an API payload) is a discriminated union
  (`{ kind: "native"; item } | { kind: "summary"; text }`), not one optional bag where half the combinations are
  invalid. A config file that a person edits is different: people flip `mode` and expect their other keys to stay.
  Keep those keys optional, say in each key's doc which mode reads it, and let the reader ignore the rest. A union
  there would make people delete settings to switch modes.
- Runtime option bags follow the same rule. A Codex-only `codexBroker` in the shared login context becomes
  `providerOptions.codex.broker`, or the Codex plugin reads its own flag.
- Saved data and code seams cost different amounts. Nest a saved shape by its axis now, even with one member,
  because moving saved data later needs a migration. Wait with a code interface until the second member (step 5),
  because code is cheap to change.

## 3. Treat a saved shape as an API

Anything written to disk has readers you do not see: other machines, older builds, a long-running proxy, the docs.
Change it like a public API:

1. Add the new shape first, with optional fields.
2. Write a pure `migrateX(raw)` in the loader, beside the existing ones. It moves the old keys to the new place and
   then deletes them. If both shapes are present, the new one wins and the old keys only fill gaps. A second run
   changes nothing. The repo has done this before: `migratePublicConfig` in `src/ai-proxy/lib/config-store.ts`
   moved `public.tunnelName` to `public.cloudflared.tunnelName` and marked the old field `@deprecated`.
3. Readers accept the old shape until the migration has run. A reader called per request (hot reload) must not fail
   on a file that is not migrated yet.
4. Writes go through the store's merge path (`mergeConfigEdit`, `AiConfigStore.mutate()`), never a raw file write.
5. A diagnostic (`doctor`, `status`, `show`) reads through the read-only path and never writes a migration back.
6. Test three things: an old-shape fixture loads into the new shape, a new-shape fixture round-trips unchanged, and
   the migration is idempotent.

Delete the old type and the reader fallback last, in their own commit, when nothing reads the old shape. An older
build that still runs (another checkout, a proxy that was not restarted) falls back to defaults for the moved keys.
Say so in the commit.

## 4. One interface, one implementation per member, one exhaustive table

When two or more implementations of one concept exist, or this change adds the second, write:

- an interface that states what every member must answer;
- one implementation per member, in that member's folder (an object literal or a class, follow the file's style);
- one table from the name to the implementation, typed `Record<Union, Impl>`. A missing member is a compile error,
  and adding a member is one entry.

```ts
// Sketch. The key type is the union of names, so tsc names every provider that has no entry.
const PROVIDER_DEFINITIONS: Record<AiProxyProviderType, ProxyProviderDefinition> = {
    "openai-subscription": { create: (account) => OpenAiSubscriptionProvider.create(account) },
    "grok-subscription": { create: (account) => GrokSubscriptionProvider.create({ account }) },
    // ...one entry per provider
};

export function createProvider(account: AiProxyAccountConfig): Promise<ProxyProvider> {
    return PROVIDER_DEFINITIONS[account.provider].create(account);
}
```

- Call sites ask the member and never compare names. A difference between providers is a member ("does it accept
  a prompt cache key?"), not an `if` in the caller.
- Prefer required members. An optional member lets the next provider forget it. When a member cannot answer, its
  implementation says so in code and in a comment (Grok's `readBackward` is bounded by bytes, because Grok history
  has no timestamps).
- Keep capability facts in one readonly member, not in many optional members that callers test for presence.
- A `switch` over a closed union is fine inside the one module that owns the union, with a `never` check in the
  default. It is not fine at a call site to pick provider behaviour.

Copy these. They are done right:

- `NativeSessionReader` (`src/utils/agent-sessions/types.ts`), with one reader per agent in
  `src/utils/agent-sessions/readers/` (`claude.ts`, `codex.ts`, `grok.ts`), reached through
  `ProviderPlugin.codingAgent` and `resolveHistoryProvider()`. A new transcript fact is a required member on all
  three (`.claude/rules/agent-transcripts.md`).
- `WorkerMetaStore<T>` (`src/utils/worker/meta-store.ts`), used by `ClaudeWorkerStore`
  (`src/claude/lib/worker/store.ts`), `CodexSessionStore` and `GrokSessionStore`: one class, options per agent,
  no copies.
- `AgentToolSpec` (`src/ai/commands/agent/spec.ts`), with object literals in `src/codex/lib/spec.ts` and
  `src/grok/lib/spec.ts`: an interface and its implementations with no class at all.
- `ProviderPlugin`, with one folder per provider under `src/utils/ai/providers/plugins/`.
- The ai-proxy `PROVIDER_DEFINITIONS` table (added 2026-10-28), which replaces the `createProvider` if-chain.

## 5. Do not abstract too early

- One implementation is a hypothetical seam. Do not write an interface for it unless this change adds the second
  member or the plan names it. A test fake counts as the second member when the real one does I/O that a test
  cannot run (files, an upstream HTTP call).
- An object literal that satisfies an interface is as good as a class. A class earns its place when it holds state
  with a lifecycle: tokens, a cache, a lock, an open handle (`Storage`, `AiConfigStore`, the `ProxyProvider`
  classes). The question is never classes or functions. It is whether provider behaviour sits behind one interface.
- Keep interfaces deep: few members, each hiding real work. Use the deletion test: if deleting a wrapper makes no
  complexity reappear in its callers, it was a pass-through, so inline it.
- Do not restructure stable code only to make it tidy. Shared knowledge across a long distance hurts only where it
  changes. Fix the volatile axes (harness, provider) first.

## 6. Keep the package direction

- `src/utils/**` is the `@genesiscz/utils` package. It never imports a tool (`@app/*`).
  `scripts/ci/check-package-boundaries.ts` fails CI on it (`.claude/rules/tools.md`).
- Dependencies point at the side that owns the interface. Shared code says what it needs, and each provider or tool
  folder implements it.
- Example: `ProviderPlugin` lives in `@genesiscz/utils`, and the `ProxyProvider` classes live in `src/ai-proxy/`.
  A `plugin.proxy()` member would make the shared package import the tool. So the proxy keeps the link from each
  provider to its plugin in its own table, inside the tool.
- Adding a provider should be one folder. If your change makes the next provider edit shared files, fix that seam
  now, or name it as a follow-up with its cost in the plan or the PR.

## 7. Know the guards

`bun run lint:rules` (`scripts/ci/lint-rules.ts`) holds ratchets that only move one way:

- `no-harness-name-branch` fails `x.harness === "codex"` or `case "grok":` outside the provider owners.
  `scripts/ci/harness-ratchet.ts` lists the files that are not migrated yet.
- `no-proxy-provider-branch` (added 2026-10-28) does the same for the ai-proxy provider names.
- No file may join a ratchet list, and a listed file that stops offending must leave it in the same commit
  (`lint-rules.test.ts` fails otherwise). A listed file is not a license: do not add a branch to it because lint
  lets you. Move the difference into the provider.
- The same seam has more guards: `no-transcript-format-outside-readers`, `no-hand-built-claude-home`,
  `no-hand-built-codex-grok-home` and `no-hook-payload-read` (`.claude/rules/agent-transcripts.md`).

## Anti-examples from this repo

Before and after code for each one: [references/examples.md](references/examples.md).

1. `claudeSessions.compaction` (`src/ai-proxy/lib/types.ts`): Codex-only knobs (`mode: "native"`, `background`)
   sit flat under a generic name, marked only by "on a Codex model" in a comment. Fix: the `sessionsIn` shape of
   step 2, a type per provider, a loader migration.
2. `createProvider` (`src/ai-proxy/lib/providers/registry.ts`): seven `if (account.provider === ...)` branches,
   plus `isProviderImplemented` as a second list of the same seven names. Fix: one exhaustive table that both read.
3. The shared login command (`src/ai/commands/accounts/login.ts`): `bindsCredentialFiles(provider)` and
   `hideHelp(provider !== "openai-sub")` choose flags in a provider-neutral file. Fix: each plugin declares its
   login flags, and the command shows what it gets.

## Which other skill to load

- **`balanced-coupling` with `review`**: a design review of a new or growing area, a decision to split or merge
  modules, or "why is this change so expensive?". They rate each link by integration strength, distance and
  volatility. `review` asks the user one question at a time, so in a background worker put the scope and the
  domain answers in the brief. Its `document` step writes to `docs/modularity-review/`. In this repo `docs/` is
  contributor documentation, so put the review where your session keeps its reports.
- **`api-and-interface-design`**: a new public interface (an export of `@genesiscz/utils`, an MCP tool, an HTTP
  route), a saved JSON shape, a CLI flag set, or a deprecation.
- **`codebase-design`** (an outside skill, not installed here; see the sources) for the vocabulary. A module has
  an interface. Depth is how much behaviour sits behind that interface. A seam is where the interface lives, and
  an adapter fills a seam. Use these words in design notes.
- The three modularity skills (`balanced-coupling`, `review`, `document`) are CC BY-NC-SA 4.0, so they are
  installed only in the main checkout and are not committed. In a linked worktree, read them from the main
  checkout's `.claude/skills/<name>/SKILL.md`. `git worktree list` prints the main checkout first.

Sources, licenses and what each one gave this skill: [references/sources.md](references/sources.md).
