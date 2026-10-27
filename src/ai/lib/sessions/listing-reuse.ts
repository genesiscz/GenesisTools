/**
 * How stale a polled who/where listing may be (the inbox, the hub timeline and worktrees). They
 * poll every 20 to 30 s beside the Genesis session list, so within this window one refresh by any
 * of them serves the rest, and a new session shows up at most this late.
 * A module of its own so a caller that only builds listing options does not load the listing.
 */
export const POLLED_LISTING_REUSE_MS = 30_000;
