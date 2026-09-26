import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    type AgentSessionRow,
    listAgentSessionRows,
    POLLED_LISTING_REUSE_MS,
} from "@app/ai/lib/sessions/agent-session-rows";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { type DecisionRecord, readDecisions } from "@app/question/lib/decisions/store";
import { byId } from "@genesiscz/utils/ai/catalog/static";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { dispatchNotification, type NotificationEvent } from "@genesiscz/utils/notifications";
import { LockTimeoutError, Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { escapeShellArg } from "@genesiscz/utils/string";
import { notifyDir } from "./notify-config";
import { type NotifyState, readNotifyState } from "./notify-poll";

// Hub notification rules (`tools hub rules`): user-defined conditions, each a macOS notification when
// it becomes true. Evaluated on the `hub-pr-notify` daemon tick (notify-daemon.ts) or by
// `tools hub rules run`; `tools hub rules test` evaluates without posting or saving. Every input is
// local: the session index, the decisions store and the PR poller's own state file. No network.

const log = logger.child({ component: "hub/rules" });

export const RULE_KINDS = ["idle", "decision", "ciFailed", "context"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RULE_KIND_LABELS: Record<RuleKind, string> = {
    idle: "Session idle longer than N minutes",
    decision: "A new decision posted",
    ciFailed: "CI failed on a watched PR",
    context: "A session's context over N %",
};

export interface HubRule {
    id: string;
    kind: RuleKind;
    enabled: boolean;
    /** Shown in the notification and the list; defaults to the kind's own words. */
    label?: string;
    /** idle: minutes without activity. */
    minutes?: number;
    /** context: percent of the model's context window. */
    percent?: number;
    /** idle, decision, context: only sessions whose project or folder contains this (case-insensitive). */
    project?: string;
    /** ciFailed: only PRs whose `<project>#<number>` contains this. */
    match?: string;
}

export interface RulesConfig {
    rules: HubRule[];
}

export interface RulesState {
    /** Rules that took their baseline: what already matched then never notifies. */
    seeded: Record<string, boolean>;
    /** Per rule, the keys already notified (or baselined), with the time. */
    fired: Record<string, Record<string, string>>;
    lastRunAt: string | null;
}

export const RULE_LIMITS = {
    idleMinMinutes: 1,
    idleMaxMinutes: 24 * 60,
    /** An idle session older than its threshold plus this is history, not news. */
    idleLookbackMinutes: 6 * 60,
    /** A context rule looks at sessions active this recently. */
    activeHours: 12,
    /** A ciFailed banner the PR poller posted this recently for the same PR suppresses the rule's. */
    ciSuppressMs: 2 * 3_600_000,
    firedKeepMs: 7 * 24 * 3_600_000,
    firedPerRule: 500,
};

/** The key in the hub config (`~/.genesis-tools/hub/config.json`, `tools hub config`) that holds the rules. */
export const RULES_CONFIG_KEY = "notificationRules";

export function rulesStatePath(dir = notifyDir()): string {
    return join(dir, "rules-state.json");
}

function isRuleKind(value: unknown): value is RuleKind {
    return typeof value === "string" && (RULE_KINDS as readonly string[]).includes(value);
}

function positive(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A rule's problem in words, or null when it can be evaluated. */
export function ruleProblem(rule: Pick<HubRule, "kind" | "minutes" | "percent">): string | null {
    if (rule.kind === "idle") {
        const minutes = rule.minutes;

        if (minutes === undefined || minutes < RULE_LIMITS.idleMinMinutes || minutes > RULE_LIMITS.idleMaxMinutes) {
            return `idle needs --minutes between ${RULE_LIMITS.idleMinMinutes} and ${RULE_LIMITS.idleMaxMinutes}`;
        }
    }

    if (rule.kind === "context" && (rule.percent === undefined || rule.percent <= 0 || rule.percent > 100)) {
        return "context needs --percent between 1 and 100";
    }

    return null;
}

export function normalizeRule(raw: unknown): HubRule | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const record = raw as Record<string, unknown>;
    const id = text(record.id);

    if (!id || !isRuleKind(record.kind)) {
        return null;
    }

    const rule: HubRule = { id, kind: record.kind, enabled: record.enabled !== false };
    const label = text(record.label);
    const minutes = positive(record.minutes);
    const percent = positive(record.percent);
    const project = text(record.project);
    const match = text(record.match);

    if (label) {
        rule.label = label;
    }

    if (minutes !== undefined) {
        rule.minutes = minutes;
    }

    if (percent !== undefined) {
        rule.percent = percent;
    }

    if (project) {
        rule.project = project;
    }

    if (match) {
        rule.match = match;
    }

    return rule;
}

export function normalizeRulesConfig(raw: unknown): RulesConfig {
    const list =
        raw && typeof raw === "object" && Array.isArray((raw as { rules?: unknown }).rules)
            ? (raw as { rules: unknown[] }).rules
            : [];
    const seen = new Set<string>();
    const rules: HubRule[] = [];

    for (const entry of list) {
        const rule = normalizeRule(entry);

        if (rule && !seen.has(rule.id)) {
            seen.add(rule.id);
            rules.push(rule);
        }
    }

    return { rules };
}

function readJson(path: string): unknown {
    if (!existsSync(path)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        log.warn({ error, path }, "rules: file unreadable, using defaults");
        return null;
    }
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(value, null, 2)}\n`);
}

export function rulesConfigPath(storage = new Storage("hub")): string {
    return `${storage.getConfigPath()} (${RULES_CONFIG_KEY})`;
}

export async function readRulesConfig(storage = new Storage("hub")): Promise<RulesConfig> {
    return normalizeRulesConfig({ rules: (await storage.getConfigValue<unknown[]>(RULES_CONFIG_KEY)) ?? [] });
}

/** One key of the hub config: the other settings in that file are left as they are. */
export async function writeRulesConfig(config: RulesConfig, storage = new Storage("hub")): Promise<void> {
    await storage.setConfigValue(RULES_CONFIG_KEY, normalizeRulesConfig(config).rules);
}

export function emptyRulesState(): RulesState {
    return { seeded: {}, fired: {}, lastRunAt: null };
}

export function readRulesState(path = rulesStatePath()): RulesState {
    const raw = readJson(path);

    if (!raw || typeof raw !== "object") {
        return emptyRulesState();
    }

    const record = raw as Partial<RulesState>;
    return {
        seeded: record.seeded && typeof record.seeded === "object" ? record.seeded : {},
        fired: record.fired && typeof record.fired === "object" ? record.fired : {},
        lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : null,
    };
}

export function newRuleId(): string {
    return `r_${randomBytes(4).toString("hex")}`;
}

export function ruleLabel(rule: HubRule): string {
    if (rule.label) {
        return rule.label;
    }

    const scope = rule.project ? ` in ${rule.project}` : rule.match ? ` on ${rule.match}` : "";

    switch (rule.kind) {
        case "idle":
            return `Idle over ${rule.minutes ?? "?"} min${scope}`;
        case "decision":
            return `New decision${scope}`;
        case "ciFailed":
            return `CI failed${scope}`;
        case "context":
            return `Context over ${rule.percent ?? "?"}%${scope}`;
    }
}

/** Adds a rule after validation; throws with the flag to fix. */
export function addRule(config: RulesConfig, input: Omit<HubRule, "id" | "enabled"> & { enabled?: boolean }): HubRule {
    const problem = ruleProblem(input);

    if (problem) {
        throw new Error(problem);
    }

    const rule = normalizeRule({ ...input, id: newRuleId(), enabled: input.enabled !== false });

    if (!rule) {
        throw new Error(`unknown rule kind "${input.kind}"; kinds: ${RULE_KINDS.join(", ")}`);
    }

    config.rules.push(rule);
    return rule;
}

// MARK: evaluation

export interface RuleSession {
    provider: string;
    sessionId: string;
    title: string;
    project: string | null;
    cwd: string;
    /** Last main-thread activity, epoch ms. */
    lastActivityMs: number;
    contextTokens: number | null;
    model: string | null;
}

export interface RulePr {
    key: string;
    ref: string;
    title: string | null;
    url: string | null;
    sha: string;
    ci: string;
}

export interface RuleInputs {
    sessions: RuleSession[];
    decisions: DecisionRecord[];
    prs: RulePr[];
    /** `${prKey}` of ciFailed banners the PR poller posted, with their time (ms). */
    postedCi: Array<{ key: string; atMs: number }>;
}

export interface RuleTarget {
    sessionId?: string;
    provider?: string;
    pr?: string;
    tab?: "decisions";
}

export interface RuleFiring {
    ruleId: string;
    kind: RuleKind;
    key: string;
    title: string;
    subtitle: string;
    message: string;
    target: RuleTarget;
}

export interface RuleReport {
    id: string;
    kind: RuleKind;
    label: string;
    enabled: boolean;
    problem: string | null;
    /** What matches right now. */
    matches: number;
    /** Matches not notified before: what this run posts (or would post). */
    fired: number;
    /** First run of the rule: its matches became the baseline instead of notifications. */
    seeded: boolean;
    note: string | null;
}

export interface RulesEvaluation {
    firings: RuleFiring[];
    reports: RuleReport[];
    state: RulesState;
}

function contains(haystack: Array<string | null | undefined>, needle: string | undefined): boolean {
    if (!needle) {
        return true;
    }

    const lower = needle.toLowerCase();
    return haystack.some((value) => value?.toLowerCase().includes(lower));
}

const CONTEXT_FALLBACK_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;

/** The model's context window; a session already past it runs the long-context variant. */
export function contextWindowFor(model: string | null, tokens: number): number {
    const known = model ? byId(model)?.contextWindow : undefined;
    const window = known && known > 0 ? known : CONTEXT_FALLBACK_WINDOW;
    return tokens > window && window < LARGE_CONTEXT_WINDOW ? LARGE_CONTEXT_WINDOW : window;
}

function formatMinutes(minutes: number): string {
    if (minutes < 60) {
        return `${Math.round(minutes)} min`;
    }

    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

interface Match {
    key: string;
    firing: Omit<RuleFiring, "ruleId" | "kind" | "key">;
}

function sessionName(session: RuleSession): string {
    return session.title || session.sessionId.slice(0, 8);
}

function matchesFor(rule: HubRule, inputs: RuleInputs, now: number): { matches: Match[]; note: string | null } {
    const label = ruleLabel(rule);

    switch (rule.kind) {
        case "idle": {
            const minutes = rule.minutes ?? 0;
            const matches = inputs.sessions
                .filter((session) => contains([session.project, session.cwd], rule.project))
                .filter((session) => {
                    const idle = (now - session.lastActivityMs) / 60_000;
                    return idle >= minutes && idle < minutes + RULE_LIMITS.idleLookbackMinutes;
                })
                .map((session) => ({
                    // The activity time is part of the key: a session that works again and stops again notifies again.
                    key: `${session.provider}:${session.sessionId}@${session.lastActivityMs}`,
                    firing: {
                        title: `${label} · ${session.project ?? "session"}`,
                        subtitle: sessionName(session),
                        message: `No activity for ${formatMinutes((now - session.lastActivityMs) / 60_000)}`,
                        target: { sessionId: session.sessionId, provider: session.provider },
                    },
                }));
            return { matches, note: null };
        }
        case "decision": {
            const matches = inputs.decisions
                .filter((row) => row.type !== "todo" && (row.state === "open" || row.state === "drafted"))
                .filter((row) => contains([row.project, row.cwd, row.repoRoot], rule.project))
                .map((row) => ({
                    key: row.id,
                    firing: {
                        title: `${label} · ${row.project ?? "decision"} #${row.number}`,
                        subtitle: row.sessionTitle ?? row.sessionId.slice(0, 8),
                        message: row.title ?? row.prompt.split("\n")[0].slice(0, 200),
                        target: {
                            sessionId: row.sessionId,
                            ...(row.provider ? { provider: row.provider } : {}),
                            tab: "decisions" as const,
                        },
                    },
                }));
            return { matches, note: null };
        }
        case "ciFailed": {
            const matches = inputs.prs
                .filter((pr) => pr.ci === "failed" && contains([pr.ref], rule.match))
                .filter(
                    (pr) =>
                        !inputs.postedCi.some(
                            (posted) => posted.key === pr.key && now - posted.atMs < RULE_LIMITS.ciSuppressMs
                        )
                )
                .map((pr) => ({
                    key: `${pr.key}@${pr.sha}`,
                    firing: {
                        title: `${label} · ${pr.ref}`,
                        subtitle: pr.title ?? pr.ref,
                        message: `CI failed on ${pr.sha.slice(0, 8)}`,
                        target: { pr: pr.ref },
                    },
                }));
            const note =
                inputs.prs.length === 0
                    ? "no watched PRs yet: tools hub notify set --repo <path> --repo-enabled on"
                    : null;
            return { matches, note };
        }
        case "context": {
            const percent = rule.percent ?? 100;
            const recent = now - RULE_LIMITS.activeHours * 3_600_000;
            const measured = inputs.sessions.filter((session) => session.contextTokens !== null);
            const matches = measured
                .filter((session) => session.lastActivityMs >= recent)
                .filter((session) => contains([session.project, session.cwd], rule.project))
                .map((session) => {
                    const tokens = session.contextTokens ?? 0;
                    const used = (tokens / contextWindowFor(session.model, tokens)) * 100;
                    return { session, used };
                })
                .filter(({ used }) => used >= percent)
                .map(({ session, used }) => ({
                    key: `${session.provider}:${session.sessionId}`,
                    firing: {
                        title: `${label} · ${session.project ?? "session"}`,
                        subtitle: sessionName(session),
                        message: `Context at ${Math.round(used)}% (${Math.round((session.contextTokens ?? 0) / 1000)}k tokens)`,
                        target: { sessionId: session.sessionId, provider: session.provider },
                    },
                }));
            const note = measured.length === 0 ? "no session reports its context size (Claude sessions do)" : null;
            return { matches, note };
        }
    }
}

function prune(fired: Record<string, string>, now: number, keep: Set<string>): Record<string, string> {
    const entries = Object.entries(fired)
        .filter(([key, at]) => keep.has(key) || now - Date.parse(at) < RULE_LIMITS.firedKeepMs)
        .sort((left, right) => left[1].localeCompare(right[1]));
    return Object.fromEntries(entries.slice(-RULE_LIMITS.firedPerRule));
}

/**
 * Pure: which rules fire now, given the inputs and what fired before. A rule's first evaluation
 * takes a baseline (its current matches are remembered, not posted), so adding "a new decision
 * posted" does not post every decision already open. A context rule re-arms once a session drops
 * below the threshold (after a compaction), an idle rule once the session works again.
 */
export function evaluateRules({
    config,
    state,
    inputs,
    now = new Date(),
}: {
    config: RulesConfig;
    state: RulesState;
    inputs: RuleInputs;
    now?: Date;
}): RulesEvaluation {
    const nowMs = now.getTime();
    const at = now.toISOString();
    const next: RulesState = { seeded: { ...state.seeded }, fired: { ...state.fired }, lastRunAt: at };
    const firings: RuleFiring[] = [];
    const reports: RuleReport[] = [];
    const ids = new Set(config.rules.map((rule) => rule.id));

    for (const rule of config.rules) {
        const problem = ruleProblem(rule);
        const base = { id: rule.id, kind: rule.kind, label: ruleLabel(rule), enabled: rule.enabled, problem };

        if (!rule.enabled || problem) {
            reports.push({ ...base, matches: 0, fired: 0, seeded: false, note: null });
            continue;
        }

        const { matches, note } = matchesFor(rule, inputs, nowMs);
        const previous = state.fired[rule.id] ?? {};
        const current = new Set(matches.map((match) => match.key));
        const seeding = !state.seeded[rule.id];
        const fresh = matches.filter((match) => !(match.key in previous));
        const fired: Record<string, string> =
            rule.kind === "context"
                ? Object.fromEntries(Object.entries(previous).filter(([key]) => current.has(key)))
                : { ...previous };

        for (const match of fresh) {
            fired[match.key] = at;

            if (!seeding) {
                firings.push({ ruleId: rule.id, kind: rule.kind, key: match.key, ...match.firing });
            }
        }

        next.fired[rule.id] = prune(fired, nowMs, current);
        next.seeded[rule.id] = true;
        reports.push({ ...base, matches: matches.length, fired: seeding ? 0 : fresh.length, seeded: seeding, note });
    }

    // A deleted rule's memory goes with it.
    for (const id of Object.keys(next.fired)) {
        if (!ids.has(id)) {
            delete next.fired[id];
            delete next.seeded[id];
        }
    }

    return { firings, reports, state: next };
}

// MARK: inputs and posting

export function ruleSessionFromRow(row: AgentSessionRow): RuleSession {
    return {
        provider: row.provider,
        sessionId: row.sessionId,
        title: row.title ?? "",
        project: row.project,
        cwd: row.cwd,
        lastActivityMs: row.lastCacheAt ?? row.mtime,
        contextTokens: typeof row.contextTokens === "number" ? row.contextTokens : null,
        model: row.model,
    };
}

/** `github.com/owner/repo#42` into `owner/repo#42`, the form `--pr` takes. */
export function prRefFromKey(key: string): string {
    const slash = key.indexOf("/");
    return slash >= 0 ? key.slice(slash + 1) : key;
}

export function rulePrsFromNotifyState(state: NotifyState): { prs: RulePr[]; postedCi: RuleInputs["postedCi"] } {
    const prs: RulePr[] = [];

    for (const [key, memory] of Object.entries(state.prs)) {
        const seen = memory.ciSeen;

        if (!seen || memory.state !== "OPEN") {
            continue;
        }

        const split = seen.lastIndexOf(":");
        const sha = split > 0 ? seen.slice(0, split) : seen;
        const ci = split > 0 ? seen.slice(split + 1) : "";
        const last = [...state.recent].reverse().find((item) => item.key === key);
        prs.push({ key, ref: prRefFromKey(key), title: last?.title ?? null, url: last?.url ?? null, sha, ci });
    }

    const postedCi = state.recent
        .filter((item) => item.type === "ciFailed" && item.posted)
        .map((item) => ({ key: item.key, atMs: Date.parse(item.at) }));
    return { prs, postedCi };
}

export async function readRuleInputs(config: RulesConfig): Promise<RuleInputs> {
    const kinds = new Set(config.rules.filter((rule) => rule.enabled).map((rule) => rule.kind));
    const needsSessions = kinds.has("idle") || kinds.has("context");
    const sessions = needsSessions
        ? await listAgentSessionRows({
              hours: Math.max(
                  RULE_LIMITS.activeHours,
                  (RULE_LIMITS.idleMaxMinutes + RULE_LIMITS.idleLookbackMinutes) / 60
              ),
              // Token and model data (the context size) only when a context rule needs it.
              withUsage: kinds.has("context"),
              maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
          })
        : [];
    const decisions = kinds.has("decision") ? readDecisions(decisionFiles().file) : [];
    const pr = kinds.has("ciFailed") ? rulePrsFromNotifyState(readNotifyState()) : { prs: [], postedCi: [] };

    return {
        sessions: sessions.filter((row) => !row.archived).map(ruleSessionFromRow),
        decisions,
        prs: pr.prs,
        postedCi: pr.postedCi,
    };
}

/** The shell line a banner click runs: the hub at the session (its Decisions pane) or the PR. */
export function ruleClickCommand(target: RuleTarget, bundle = genesisAppBundlePath()): string {
    const args = ["/usr/bin/open", "-n", bundle, "--args", "--hub"];

    if (target.pr) {
        args.push("--mode", "prs", "--pr", target.pr);
    } else if (target.sessionId) {
        args.push("--session", target.sessionId);

        if (target.tab) {
            args.push("--tab", target.tab);
        }
    }

    return args.map(escapeShellArg).join(" ");
}

export function ruleNotification(firing: RuleFiring, bundle?: string): NotificationEvent {
    return {
        app: "hub",
        title: firing.title,
        subtitle: firing.subtitle,
        message: firing.message,
        group: `hub-rule-${firing.ruleId}-${firing.key}`.slice(0, 120),
        execute: ruleClickCommand(firing.target, bundle),
    };
}

export interface RulesRunResult {
    ranAt: string;
    dryRun: boolean;
    skipped: string | null;
    reports: RuleReport[];
    firings: RuleFiring[];
    posted: number;
}

/**
 * One evaluation. `dryRun` (tools hub rules test) posts nothing and saves nothing. The state file is
 * written under a lock, so the daemon tick and a manual `rules run` never post the same thing twice.
 */
export async function runRules({
    dryRun = false,
    now = new Date(),
    readConfig = () => readRulesConfig(),
    statePath = rulesStatePath(),
    inputs,
    post = (firing: RuleFiring) => dispatchNotification(ruleNotification(firing)),
}: {
    dryRun?: boolean;
    now?: Date;
    readConfig?: () => Promise<RulesConfig>;
    statePath?: string;
    inputs?: (config: RulesConfig) => Promise<RuleInputs>;
    post?: (firing: RuleFiring) => Promise<boolean>;
} = {}): Promise<RulesRunResult> {
    const config = await readConfig();
    const readInputs = inputs ?? readRuleInputs;
    const empty: RulesRunResult = {
        ranAt: now.toISOString(),
        dryRun,
        skipped: null,
        reports: [],
        firings: [],
        posted: 0,
    };

    if (config.rules.length === 0) {
        return { ...empty, skipped: "no rules (tools hub rules add)" };
    }

    const evaluate = async (): Promise<RulesRunResult> => {
        const state = readRulesState(statePath);
        const evaluation = evaluateRules({ config, state, inputs: await readInputs(config), now });
        let posted = 0;

        if (!dryRun) {
            for (const firing of evaluation.firings) {
                if (await post(firing)) {
                    posted++;
                    continue;
                }

                // Not delivered: forget it, so the next tick tries again instead of treating it as sent.
                delete evaluation.state.fired[firing.ruleId]?.[firing.key];
                log.warn(
                    { rule: firing.ruleId, key: firing.key },
                    "hub rules: a notification did not post; retrying next run"
                );
            }

            writeJson(statePath, evaluation.state);
        }

        log.info(
            { dryRun, rules: config.rules.length, firings: evaluation.firings.length, posted },
            "hub rules evaluated"
        );
        return { ...empty, reports: evaluation.reports, firings: evaluation.firings, posted };
    };

    if (dryRun) {
        return evaluate();
    }

    try {
        return await withFileLock(`${statePath}.lock`, evaluate, 2000);
    } catch (error) {
        if (error instanceof LockTimeoutError) {
            return { ...empty, skipped: "another rules run holds the lock" };
        }

        throw error;
    }
}
