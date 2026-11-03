import { loadPins, type SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import { agentPluginId } from "@genesiscz/utils/ai/usage/spend/drivers";
import { CLAUDE_ALL_ACCOUNT_ID, UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage/types";

/** One session as attribution sees it: which harness wrote it, its lead session id, and the account its home names. */
export interface SessionRef {
    agent: AgentKind;
    /** The lead session (the id the pin journal keys); a sub-agent's file passes its lead's id. */
    sessionId: string;
    transcriptPath: string;
    /** The account id the transcript's root belongs to, from the spend root map; undefined when unbound. */
    homeAccountId?: string;
}

export type SessionAccountBasis = "pin" | "home" | "none";

export interface SessionAccount {
    account?: AccountKey;
    basis: SessionAccountBasis;
    /** The pin journal keeps only a session's LAST pin, so a session that changed account is attributed to the last. */
    approximate: boolean;
}

/** What every source reads, loaded once per answer. */
export interface SessionAccountLookup {
    /** Every known account, in `AccountKey` form (the usage directory). */
    directory: readonly AccountKey[];
    pins: ReadonlyMap<string, SessionPin>;
}

/** Which account ran a session. Claude transcripts carry no account, so Claude reads the pin journal. */
export interface SessionAccountSource {
    accountOf(session: SessionRef, lookup: SessionAccountLookup): SessionAccount;
}

function keyFor(provider: string, value: string, directory: readonly AccountKey[]): AccountKey {
    return (
        directory.find(
            (key) => key.provider === provider && (key.accountId === value || key.accountName === value)
        ) ?? { provider, accountId: value, accountName: value }
    );
}

const NONE: SessionAccount = { basis: "none", approximate: false };

/** The session's pin names its account by name or id. */
export const pinJournalSource: SessionAccountSource = {
    accountOf(session, lookup) {
        const pin = lookup.pins.get(session.sessionId);

        if (!pin?.account) {
            return NONE;
        }

        return {
            account: keyFor(agentPluginId(session.agent), pin.account, lookup.directory),
            basis: "pin",
            approximate: true,
        };
    },
};

/**
 * The account whose home holds the transcript. Homes shared by every account (the default Codex home) bind to no
 * account, so the session's pin answers next, and only then is the session unattributed.
 */
export const providerHomeSource: SessionAccountSource = {
    accountOf(session, lookup) {
        const id = session.homeAccountId;

        if (id && id !== UNBOUND_ACCOUNT_ID && id !== CLAUDE_ALL_ACCOUNT_ID) {
            return {
                account: keyFor(agentPluginId(session.agent), id, lookup.directory),
                basis: "home",
                approximate: false,
            };
        }

        return pinJournalSource.accountOf(session, lookup);
    },
};

/** One entry per harness (design 2026-11-01 section 4): a new harness adds its source here. */
export const SESSION_ACCOUNT_SOURCES = {
    claude: pinJournalSource,
    codex: providerHomeSource,
    grok: providerHomeSource,
} satisfies Record<AgentKind, SessionAccountSource>;

export function sessionAccountOf(session: SessionRef, lookup: SessionAccountLookup): SessionAccount {
    return SESSION_ACCOUNT_SOURCES[session.agent].accountOf(session, lookup);
}

/** The lookup for one answer: the pin journal read once, read-only (a usage answer never compacts the journal). */
export async function loadSessionAccountLookup(directory: readonly AccountKey[]): Promise<SessionAccountLookup> {
    return { directory, pins: await loadPins({ readOnly: true }) };
}
