import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import { agentPluginId, spendDriver, type TranscriptOwner } from "@genesiscz/utils/ai/usage/spend/drivers";
import type { CompactEvent } from "@genesiscz/utils/ai/usage/spend/events-cache";
import type { SessionAccount, SessionAccountLookup } from "./session-account";

/** One spend event with its session and the account that session ran on. */
export interface AttributedEvent {
    at: number;
    costUsd: number;
    tokens: number;
    unpriced: boolean;
    model: string | null;
    /** Plugin id of the harness's provider (`anthropic-sub` for Claude). */
    provider: string;
    agent: CompactEvent["source"];
    owner: TranscriptOwner;
    account: SessionAccount;
}

/** Events of the spend cache (collected `withFile`), each with its owner and account; an event with no file is dropped. */
export function attributeEvents(events: readonly CompactEvent[], lookup: SessionAccountLookup): AttributedEvent[] {
    const perFile = new Map<string, { owner: TranscriptOwner; account: SessionAccount }>();
    const out: AttributedEvent[] = [];

    for (const event of events) {
        const at = Date.parse(event.t);

        if (!event.file || Number.isNaN(at)) {
            continue;
        }

        let known = perFile.get(event.file);

        if (!known) {
            const driver = spendDriver(event.source);
            const owner = driver.transcriptOwner(event.file);
            const account = driver.sessionAccount.accountOf(
                {
                    agent: event.source,
                    sessionId: owner.leadSessionId,
                    transcriptPath: event.file,
                    ...(event.accountId === undefined ? {} : { homeAccountId: event.accountId }),
                },
                lookup
            );
            known = { owner, account };
            perFile.set(event.file, known);
        }

        out.push({
            at,
            costUsd: event.costUsd,
            tokens: event.tokens,
            unpriced: event.unpriced === true,
            model: event.model ?? null,
            provider: agentPluginId(event.source),
            agent: event.source,
            ...known,
        });
    }

    return out.sort((a, b) => a.at - b.at);
}

/** One lead session's part of a span on an account. */
export interface SessionShare {
    agent: CompactEvent["source"];
    sessionId: string;
    project: string;
    costUsd: number;
    /** The lead's own calls. */
    mainUsd: number;
    /** Its sub-agents' calls. */
    subagentUsd: number;
    tokens: number;
    /** Of the attributed and unattributed dollars of the span, 0..1. */
    share: number;
    basis: SessionAccount["basis"];
    approximate: boolean;
    /** The command that opens the session's own report. */
    next: string;
}

export interface SpanShares {
    sessions: SessionShare[];
    /** Spend of the account's provider in the span whose session names no account (no pin, unbound home). */
    unattributed: { costUsd: number; tokens: number; share: number };
    totalUsd: number;
    /** Events with no known rate: their dollars are missing, never zero. */
    unpriced: number;
}

function sameAccount(a: AccountKey, b: AccountKey): boolean {
    return a.provider === b.provider && (a.accountId === b.accountId || a.accountName === b.accountName);
}

/**
 * The sessions that spent on `account` between `from` and `to` (epoch ms, inclusive), largest first, plus the spend
 * of the same provider that no account claims. Events of another account are not part of the answer.
 */
export function sharesIn(input: {
    events: readonly AttributedEvent[];
    account: AccountKey;
    from: number;
    to: number;
    reportCommand: (sessionId: string) => string;
}): SpanShares {
    const sessions = new Map<string, SessionShare>();
    const unattributed = { costUsd: 0, tokens: 0, share: 0 };
    let unpriced = 0;

    for (const event of input.events) {
        if (event.at < input.from || event.at > input.to || event.provider !== input.account.provider) {
            continue;
        }

        const own = event.account.account !== undefined && sameAccount(event.account.account, input.account);

        if (!own && event.account.basis !== "none") {
            continue;
        }

        if (event.unpriced) {
            unpriced += 1;
        }

        if (!own) {
            unattributed.costUsd += event.costUsd;
            unattributed.tokens += event.tokens;
            continue;
        }

        const key = `${event.agent}\u0000${event.owner.leadSessionId}`;
        let row = sessions.get(key);

        if (!row) {
            row = {
                agent: event.agent,
                sessionId: event.owner.leadSessionId,
                project: event.owner.project,
                costUsd: 0,
                mainUsd: 0,
                subagentUsd: 0,
                tokens: 0,
                share: 0,
                basis: event.account.basis,
                approximate: event.account.approximate,
                next: input.reportCommand(event.owner.leadSessionId),
            };
            sessions.set(key, row);
        }

        row.costUsd += event.costUsd;
        row.tokens += event.tokens;

        if (event.owner.subagent) {
            row.subagentUsd += event.costUsd;
        } else {
            row.mainUsd += event.costUsd;
        }
    }

    const rows = [...sessions.values()];
    const totalUsd = rows.reduce((sum, row) => sum + row.costUsd, 0) + unattributed.costUsd;

    for (const row of rows) {
        row.share = totalUsd > 0 ? row.costUsd / totalUsd : 0;
    }

    unattributed.share = totalUsd > 0 ? unattributed.costUsd / totalUsd : 0;

    return { sessions: rows.sort((a, b) => b.costUsd - a.costUsd), unattributed, totalUsd, unpriced };
}
