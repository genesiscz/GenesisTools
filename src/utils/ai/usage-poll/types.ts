export type {
    AccountUsageFeature,
    AccountUsageSnapshot,
    LimitKind,
    LimitMoney,
    LimitSeverity,
    LimitWindow,
    UsagePollOptions,
    UsagePresenters,
} from "@genesiscz/utils/ai/providers/account-features";

/** One provider's slice of a poll round, as the TUI and the daemon consume it. */
export interface PollResult<T> {
    provider: string;
    accounts: T[];
    /** Epoch ms of the fetch that produced `accounts`. */
    fetchedAt: number;
}
