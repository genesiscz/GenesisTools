import type { ComponentType } from "react";
import type { AccountEntry } from "../config/schema";

/**
 * Account lifecycle and quota features of a provider plugin: login flows, home discovery,
 * usage polling, and where an account's coding-agent transcripts live.
 *
 * This is the `accounts` member of `ProviderPlugin` (spec 2026-09-04, section 4.1). It is
 * a member, not a new noun, because "Provider" and "Driver" already carry two meanings each
 * in this repo (`ProviderPlugin` vs ai-proxy's `ProxyProvider`, ai-spend's `MonitorDriver`).
 * Presence of a method is the capability declaration: a plugin without `loginLong` has no
 * long-lived token concept, and the CLI hides that subcommand for it.
 *
 * Every write to the config store happens in the CLI layer through `account-ops.ts` or
 * `AiConfigStore.mutate`; a flow only RETURNS what it obtained (`LoginOutcome`). Never the
 * v3 `AIConfig` facade: its bridge matches accounts by name and deletes any account absent
 * from the projected list (`store-bridge.ts:104,164-168`).
 */

/** Interactive context. TTY prompts go through the `p.*` facade set by the entrypoint. */
export interface AccountFlowContext {
    /** Present when the flow targets an existing account (re-login, login-long, logout). */
    account?: AccountEntry;
    /** Requested account name for a first login; the flow may derive one from the identity. */
    requestedName?: string;
    /** Vendor home to log into or bind (`--home`): a codex profile dir, a grok GROK_HOME. */
    home?: string;
    /** An existing credential file to bind without running a flow (`--auth-file`). */
    authFile?: string;
    /** `isInteractive()` at the CLI edge. */
    interactive: boolean;
    /** Diagnosis only: read, never rotate or spend a single-use credential. */
    probe?: boolean;
    /** Open a URL in the browser; injected so tests never spawn `open`. */
    openUrl?: (url: string) => Promise<void>;
    fetch?: typeof fetch;
}

/** Whose credential this is. Used by the identity guard before overwriting an account. */
export interface AccountIdentity {
    email?: string;
    /** Anthropic account uuid, ChatGPT account id, xAI user id. */
    accountUuid?: string;
    organizationUuid?: string;
    /** `max`, `pro`, `plus`, `SuperGrok Heavy`, ... */
    plan?: string;
    /** Never persisted. */
    raw?: Record<string, unknown>;
}

/** What a login produced, before anything is written. The CLI layer writes it. */
export interface LoginOutcome {
    /** Plugin id. */
    provider: string;
    /** Fields to store; secrets get vaulted by account-ops, never written plain. */
    credentials: Partial<AccountEntry["credentials"]>;
    identity?: AccountIdentity;
    /** Name and label suggestions when the caller gave none. */
    suggestedName?: string;
    suggestedLabel?: string;
    /** Extra top-level fields (plan, fingerprint) the flow learned. */
    accountFields?: Partial<
        Pick<
            AccountEntry,
            | "label"
            | "organizationUuid"
            | "accountUuid"
            | "subscriptionPlan"
            | "subscriptionStatus"
            | "subscriptionCreatedAt"
            | "subscriptionCheckedAt"
        >
    >;
}

/** A home on disk that belongs to one account of this provider (codex profiles, grok homes). */
export interface DiscoveredHome {
    /** Absolute dir. */
    home: string;
    /** Absolute path if the provider keeps auth in a file. */
    authFile?: string;
    /** Decoded WITHOUT network (JWT claims, profile files). */
    identity?: AccountIdentity;
    /** Already referenced by an AccountEntry (matched on authFile or dataDir). */
    boundToAccountId?: string;
}

export type LimitKind = "session" | "weekly" | "monthly" | "scoped" | "credit";

export type LimitSeverity = "ok" | "warn" | "critical";

/** Credit-style windows report money instead of percent. Minor units, like cents. */
export interface LimitMoney {
    usedMinor: number;
    limitMinor?: number;
    currency: string;
    exponent: number;
}

/** One rate-limit window, provider-neutral. Claude has 5 to 6, codex 2, grok 1 (monthly). */
export interface LimitWindow {
    /** Provider-native id: `five_hour`, `seven_day_opus`, `primary`, `monthly`. */
    key: string;
    /** Human: `5h`, `7d Opus`, `Weekly`, `Monthly`. */
    label: string;
    kind: LimitKind;
    /** `opus`, `sonnet`, `fable` for scoped windows. */
    scopeModel?: string;
    /** 0..100, may exceed 100. */
    percentUsed: number;
    /** ISO. */
    resetsAt?: string;
    /** Window length when known, drives "imminent reset" logic. */
    periodMs?: number;
    severity?: LimitSeverity;
    isActive?: boolean;
    money?: LimitMoney;
}

/** The unit the TUI, the daemon, the dashboard and the Genesis app all consume. */
export interface AccountUsageSnapshot {
    /** Plugin id. */
    provider: string;
    /** `AccountEntry.id`. */
    accountId: string;
    accountName: string;
    label?: string;
    /** ISO. */
    fetchedAt: string;
    limits: LimitWindow[];
    plan?: { name?: string; status?: string; createdAt?: string; checkedAt?: string; contradictedAt?: number };
    /** Login health, provider-neutral. */
    auth?: { refreshExpiresAt?: string; longLivedExpiresAt?: string; orgBlocked?: boolean; reason?: string };
    stale?: { lastSuccessAt: string; reason: string };
    error?: string;
    /** Provider-native payload for provider presenters and for the legacy cache projection. Stripped on every wire. */
    native?: unknown;
}

export interface UsagePollOptions {
    /** Never rotate a token. */
    probe?: boolean;
    /** Bypass the shared cache. */
    force?: boolean;
    fetch?: typeof fetch;
    /**
     * Accounts the PREVIOUS round found blocked at the provider's org level, by name.
     * A provider that answers a dead subscription with a rate-limit status uses this to
     * skip the "rotate the token and retry" unlock, which for such an account only spends
     * a single-use grant on a request that cannot succeed.
     */
    orgBlocked?: ReadonlySet<string>;
}

/** Where this account's coding-agent transcripts live, for the transcript spend. */
export interface SpendScope {
    /** Roots on disk that belong to this account. */
    transcriptRoots: string[];
    /** Source id for ai-spend. */
    source: "claude" | "codex" | "grok";
}

/**
 * Provider-specific parts of the usage TUI. Optional: without a presenter the generic
 * renderer draws `LimitWindow[]` as bars. Components are Ink components; the type only
 * needs React's `ComponentType`, so this layer stays free of Ink imports.
 */
export interface UsagePresenters {
    /** Replace the generic per-account block in the Overview tab. */
    AccountSection?: ComponentType<{
        snapshot: AccountUsageSnapshot;
        width: number;
        prominent: string[];
        paceScope?: string;
    }>;
    /** Urgency sort. Absent means config order only. */
    score?(snapshots: AccountUsageSnapshot[]): AccountUsageSnapshot[];
    /**
     * Rendered line count of one `AccountSection` at that width. The Overview tab uses it
     * to decide between one and two columns, so a presenter whose block is taller than the
     * generic bars must supply it or the layout under-counts and overflows.
     */
    estimateHeight?(snapshot: AccountUsageSnapshot, opts: { width: number; prominent: string[] }): number;
    /** Narrowest column this presenter still renders cleanly in. */
    minColumnWidth?: number;
    /**
     * Extra rows for the `?` overlay, as the overlay renders them: `[key, description]`.
     * An empty key makes the row a heading, an empty pair a blank line.
     */
    helpLines?: Array<[key: string, description: string]>;
    /** Colour for a window; default is the percent thresholds. */
    colorFor?(window: LimitWindow, now: number): "red" | "yellow" | "green";
}

export interface AccountPresentation {
    /** `Claude`, `Codex`, `Grok`. */
    displayName: string;
    /** `claude`, `codex`, `grok`. */
    alias: string;
    /** Windows in display order; a provider may return fewer at runtime. */
    limitOrder: string[];
    /** Windows shown by default in compact views (TUI overview, menubar). */
    prominentLimits: string[];
    /** Thresholds for "imminent reset" per kind, ms. */
    imminentResetMs?: Partial<Record<LimitKind, number>>;
}

export type LogoutTarget = "oauth" | "longLived" | "secondary" | "authFile";

export interface ExternalLoginInstruction {
    /** Command to run, argv form. */
    command: string[];
    env?: Record<string, string>;
    /** The file that command writes, to bind afterwards. */
    authFile: string;
}

export interface AccountUsageFeature {
    poll(account: AccountEntry, opts: UsagePollOptions): Promise<AccountUsageSnapshot>;
    presenters?: UsagePresenters;
    /** Floor between two live polls of one account; the daemon and the shared cache enforce it. Default 30s. */
    minIntervalMs?: number;
}

export interface AccountFeatures {
    /** Vocabulary the generic TUI and dashboard need without knowing the provider. */
    readonly presentation: AccountPresentation;

    /** Interactive first login or re-login. Absent means "run the vendor CLI" (grok today). */
    login?(ctx: AccountFlowContext): Promise<LoginOutcome>;
    /** Long-lived token attach (Anthropic only today). */
    loginLong?(ctx: AccountFlowContext & { pastedToken?: string }): Promise<LoginOutcome>;
    /** Secondary isolated grant (Anthropic only today). */
    loginSecondary?(ctx: AccountFlowContext): Promise<LoginOutcome>;
    /** Which credential fields logout may clear, in the order the CLI offers them. */
    readonly logoutTargets: readonly LogoutTarget[];
    /** Instructions when the flow is external (grok): command to run and the file it writes. */
    externalLogin?(ctx: AccountFlowContext): ExternalLoginInstruction;

    /** Enumerate homes on disk not yet bound to an account. Absent for Anthropic (no home). */
    discoverHomes?(): Promise<DiscoveredHome[]>;
    /** Decode identity from stored credentials without network (JWT claims). */
    identityOf?(account: AccountEntry, ctx?: { probe?: boolean }): Promise<AccountIdentity | undefined>;

    /** Live quota. Absent when the vendor exposes nothing. */
    usage?: AccountUsageFeature;

    /** Where this account's coding-agent transcripts live, for the transcript spend. */
    spendScope?(account: AccountEntry): SpendScope | undefined;
}
