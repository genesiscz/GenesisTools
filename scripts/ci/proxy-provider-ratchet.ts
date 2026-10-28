/**
 * The files outside `src/ai-proxy/lib/providers/` that still compare an ai-proxy provider name
 * (`AiProxyProviderType`), and how many comparisons each may keep. Counted 2026-10-28 when lint-rules
 * `no-proxy-provider-branch` was added (HTML review 3.3, points 3, 4 and 6): 71 comparisons in 17 files before the
 * `PROVIDER_DEFINITIONS` table, 9 in 5 files after it. Ratchet: a file may not join the list, a count may only go
 * down, lint-rules fails a file with one comparison more than its count, and `lint-rules.test.ts` fails a count above
 * the file's real number. A provider difference belongs in its `ProviderDefinition`
 * (`src/ai-proxy/lib/providers/definition.ts`) or in its `ProxyProvider`.
 */
export const PROXY_PROVIDER_BRANCH_RATCHET: ReadonlyMap<string, number> = new Map<string, number>([
    // Commands that exist for one provider: `accounts status` and `accounts bind` are Codex's, `set-routing` is
    // OpenRouter's. A member pays off once a second provider gets such a command.
    ["src/ai-proxy/commands/accounts.ts", 3],
    // `accounts login codex` finds the proxy account of a Codex login (worker login-seams owns the file).
    ["src/ai-proxy/commands/accounts-login.ts", 1],
    // The setup wizard's Cursor example is written for a Grok account.
    ["src/ai-proxy/commands/config-wizard.ts", 1],
]);
