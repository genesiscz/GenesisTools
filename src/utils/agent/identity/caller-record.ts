import { z } from "zod";
import { TERMINAL_IDS } from "./terminals";
import type { AgentIdentity, IdentityFacet } from "./types";

/**
 * The facets a decision's record fills beside the env-only facts: the live folder and its git facts, the model from
 * the session's transcript (about 400 ms, once per command), and the T3 Code thread's title and lead thread (one
 * indexed read of T3's database, only inside T3 Code). The harness, session, subagent, effort, account, terminal and
 * host thread come from the environment and cost nothing.
 */
export const CALLER_RECORD_FACETS = ["cwd", "git", "model", "host"] as const satisfies readonly IdentityFacet[];

const terminalSchema = z.record(z.string(), z.string().nullable());

/**
 * Who made or relayed a decision, kept on the decision itself so a reader knows exactly which session did it: the
 * harness and session, the subagent inside it, the model and effort, the account the harness bills, the checkout it
 * ran in, its terminal (the cmux surface a person can focus) and the host app's thread. Every field but the harness
 * and the session is optional, and readers accept a record without them, so a newer fact never breaks an old reader.
 */
export const callerRecordSchema = z.object({
    harness: z.string().min(1),
    session: z.string().nullable(),
    subagent: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    account: z
        .object({ harness: z.string(), account: z.string().nullable(), proxyTarget: z.string().nullable() })
        .optional(),
    checkout: z
        .object({
            cwd: z.string().optional(),
            project: z.string().optional(),
            repoRoot: z.string().optional(),
            branch: z.string().optional(),
            worktree: z.string().optional(),
        })
        .optional(),
    /** Each terminal of `TERMINAL_ENRICHERS` the caller ran in, by its id: `cmux` { surfaceId, workspaceId, tabId }. */
    terminal: z.record(z.string(), terminalSchema).optional(),
    host: z
        .object({
            app: z.string(),
            threadId: z.string(),
            title: z.string().optional(),
            parentThreadId: z.string().optional(),
            parentTitle: z.string().optional(),
        })
        .optional(),
});
export type CallerRecord = z.infer<typeof callerRecordSchema>;

/** The identity fields `callerRecordOf` reads; a test passes only the ones it cares about. */
export type CallerRecordSource = Pick<AgentIdentity, "agent" | "sessionId"> &
    Partial<
        Pick<
            AgentIdentity,
            | "subagentId"
            | "model"
            | "effort"
            | "account"
            | "cwd"
            | "project"
            | "repoRoot"
            | "branch"
            | "worktreePath"
            | "terminal"
            | "host"
        >
    >;

function setText<T extends object, K extends keyof T>(into: T, key: K, value: string | null | undefined): void {
    if (value) {
        Object.assign(into, { [key]: value });
    }
}

function textFields(slot: object): Record<string, string | null> {
    const fields: Record<string, string | null> = {};

    for (const [key, value] of Object.entries(slot)) {
        if (typeof value === "string" || value === null) {
            fields[key] = value;
        }
    }

    return fields;
}

/** The record of an identity: each fact only when the identity has it, so an env-only identity gives a short record. */
export function callerRecordOf(identity: CallerRecordSource): CallerRecord {
    const record: CallerRecord = { harness: identity.agent, session: identity.sessionId };
    setText(record, "subagent", identity.subagentId);
    setText(record, "model", identity.model);
    setText(record, "effort", identity.effort);

    if (identity.account) {
        const { harness, account, proxyTarget } = identity.account;
        record.account = { harness, account, proxyTarget };
    }

    const checkout: NonNullable<CallerRecord["checkout"]> = {};
    setText(checkout, "cwd", identity.cwd);
    setText(checkout, "project", identity.project);
    setText(checkout, "repoRoot", identity.repoRoot);
    setText(checkout, "branch", identity.branch);
    setText(checkout, "worktree", identity.worktreePath);

    if (Object.keys(checkout).length > 0) {
        record.checkout = checkout;
    }

    const terminal: NonNullable<CallerRecord["terminal"]> = {};

    for (const id of TERMINAL_IDS) {
        const slot = identity.terminal?.[id];

        if (slot) {
            terminal[id] = textFields(slot);
        }
    }

    if (Object.keys(terminal).length > 0) {
        record.terminal = terminal;
    }

    if (identity.host) {
        const { app, threadId, title, parentThreadId, parentTitle } = identity.host;
        const host: NonNullable<CallerRecord["host"]> = { app, threadId };
        setText(host, "title", title);
        setText(host, "parentThreadId", parentThreadId);
        setText(host, "parentTitle", parentTitle);
        record.host = host;
    }

    return record;
}

/** The part of a record that a row in a list names: the harness, the session and the model (`callerBrief`). */
export interface CallerBrief {
    harness: string;
    session?: string;
    model?: string;
}

/**
 * Who did it, as a row in a list names it. The checkout, terminal, account and host thread stay on the stored record,
 * so a snapshot of many rows carries only these three.
 */
export function callerBrief(record: CallerRecord): CallerBrief {
    return {
        harness: record.harness,
        ...(record.session ? { session: record.session } : {}),
        ...(record.model ? { model: record.model } : {}),
    };
}

/** One line for a person: "Claude Code, session f94af8c6 · opus · GenesisTools on feat/x · cmux surface 3F2A". */
export function callerRecordLine(record: CallerRecord, harnessName: (harness: string) => string = (h) => h): string {
    const parts = [`${harnessName(record.harness)}${record.session ? `, session ${record.session.slice(0, 8)}` : ""}`];

    if (record.subagent) {
        parts.push(`subagent ${record.subagent.slice(0, 8)}`);
    }

    if (record.model) {
        parts.push(record.effort ? `${record.model} (${record.effort})` : record.model);
    }

    const where = record.checkout?.project ?? record.checkout?.repoRoot;

    if (where) {
        parts.push(record.checkout?.branch ? `${where} on ${record.checkout.branch}` : where);
    }

    const surface = record.terminal?.cmux?.surfaceId;

    if (surface) {
        parts.push(`cmux surface ${surface}`);
    }

    if (record.host) {
        parts.push(`${record.host.app} thread ${record.host.title ?? record.host.threadId}`);
    }

    return parts.join(" · ");
}
