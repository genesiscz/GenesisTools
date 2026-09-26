import type { NotifyEvent } from "./notify-config";

// The PR notifier's decision core: a fresh snapshot of one PR against what the last poll remembered
// gives the events worth a notification. Pure, so every rule below has a test.

export type PrCi = "success" | "failed" | "running" | "pending" | null;

export interface ThreadStart {
    id: string;
    author: string | null;
    bot: boolean;
    path: string | null;
}

export interface BotReview {
    id: string;
    author: string;
    state: string | null;
}

/** One PR/MR as a poll saw it. */
export interface PrSnapshot {
    /** `<host>/<project>#<number>`: stable across polls and repos. */
    key: string;
    provider: "github" | "gitlab";
    project: string;
    number: number;
    title: string;
    url: string;
    author: string | null;
    mine: boolean;
    state: "OPEN" | "MERGED" | "CLOSED";
    headSha: string | null;
    ci: PrCi;
    /**
     * Threads the poll saw, oldest first. null: not fetched this time because nothing changed
     * (GitLab asks for discussions only when the MR's note count moved).
     */
    threads: ThreadStart[] | null;
    /** GitLab's note count, the cheap signal that decides whether threads are fetched. */
    notes: number | null;
    botReviews: BotReview[];
}

/** What the notifier keeps per PR between polls. */
export interface PrMemory {
    state: PrSnapshot["state"];
    threadIds: string[];
    botReviewIds: string[];
    /** `<sha>:<ci>` of the last CI result that was notified, or recorded as the baseline. */
    ciSeen: string | null;
    notes: number | null;
    seenAt: string;
}

export interface NotifyItem {
    type: NotifyEvent;
    key: string;
    provider: PrSnapshot["provider"];
    project: string;
    number: number;
    url: string;
    title: string;
    message: string;
    /** CI events: the head commit the result is about. */
    sha?: string;
}

/** Ids kept per PR; a PR with more threads than this only forgets its oldest, which never come back. */
const MAX_REMEMBERED_IDS = 400;

function remember(previous: string[], next: string[]): string[] {
    const merged = [...new Set([...previous, ...next])];
    return merged.length > MAX_REMEMBERED_IDS ? merged.slice(merged.length - MAX_REMEMBERED_IDS) : merged;
}

function label(pr: PrSnapshot): string {
    return `${pr.project.split("/").pop() ?? pr.project}${pr.provider === "gitlab" ? "!" : "#"}${pr.number}`;
}

function ciKey(pr: PrSnapshot): string | null {
    return pr.headSha && (pr.ci === "success" || pr.ci === "failed") ? `${pr.headSha}:${pr.ci}` : null;
}

function names(list: string[]): string {
    const unique = [...new Set(list)];
    return unique.length <= 2 ? unique.join(" and ") : `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more`;
}

export function memoryOf(pr: PrSnapshot, previous: PrMemory | undefined, now: string): PrMemory {
    return {
        state: pr.state,
        threadIds: remember(
            previous?.threadIds ?? [],
            (pr.threads ?? []).map((t) => t.id)
        ),
        botReviewIds: remember(
            previous?.botReviewIds ?? [],
            pr.botReviews.map((r) => r.id)
        ),
        ciSeen: ciKey(pr) ?? previous?.ciSeen ?? null,
        notes: pr.notes ?? previous?.notes ?? null,
        seenAt: now,
    };
}

/**
 * The events between what the last poll remembered and this snapshot. A PR seen for the first time
 * only records a baseline: turning the notifier on must not post one banner per open PR.
 */
export function diffPr({
    previous,
    pr,
    viewer,
    events,
    onlyMine,
    now,
}: {
    previous: PrMemory | undefined;
    pr: PrSnapshot;
    viewer: string | null;
    events: Record<NotifyEvent, boolean>;
    onlyMine: boolean;
    now: string;
}): { items: NotifyItem[]; memory: PrMemory } {
    const memory = memoryOf(pr, previous, now);

    if (!previous || (onlyMine && !pr.mine)) {
        return { items: [], memory };
    }

    const items: NotifyItem[] = [];
    const base = {
        key: pr.key,
        provider: pr.provider,
        project: pr.project,
        number: pr.number,
        url: pr.url,
        title: pr.title,
    };
    const tag = label(pr);

    if (events.thread && pr.threads) {
        const seen = new Set(previous.threadIds);
        const fresh = pr.threads.filter((t) => !seen.has(t.id) && !t.bot && (viewer === null || t.author !== viewer));

        if (fresh.length > 0) {
            const who = names(fresh.map((t) => t.author ?? "someone"));
            const files = [...new Set(fresh.map((t) => t.path).filter((p): p is string => Boolean(p)))];
            items.push({
                ...base,
                type: "thread",
                message: `${fresh.length === 1 ? "A new review thread" : `${fresh.length} new review threads`} from ${who}${
                    files.length === 1 ? ` on ${files[0]}` : ""
                }`,
            });
        }
    }

    if (events.botReview) {
        const seen = new Set(previous.botReviewIds);
        const fresh = pr.botReviews.filter((r) => !seen.has(r.id));

        if (fresh.length > 0) {
            items.push({
                ...base,
                type: "botReview",
                message: `${names(fresh.map((r) => r.author))} finished a review on ${tag}`,
            });
        }
    }

    const ci = ciKey(pr);

    if (ci && ci !== previous.ciSeen && pr.state === "OPEN") {
        const type = pr.ci === "failed" ? "ciFailed" : "ciPassed";

        if (events[type]) {
            items.push({
                ...base,
                type,
                message: `CI ${pr.ci === "failed" ? "failed" : "passed"} on ${tag} at ${pr.headSha?.slice(0, 7)}`,
                ...(pr.headSha ? { sha: pr.headSha } : {}),
            });
        }
    }

    if (events.merged && previous.state === "OPEN" && pr.state === "MERGED") {
        items.push({ ...base, type: "merged", message: `${tag} was merged` });
    }

    return { items, memory };
}

/** Memories of PRs no poll has seen for `days` go, so the state file stays small. */
export function pruneMemory(memory: Record<string, PrMemory>, now: Date, days = 30): Record<string, PrMemory> {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    return Object.fromEntries(Object.entries(memory).filter(([, m]) => Date.parse(m.seenAt) >= cutoff));
}

const BOT_NAME = /\[bot\]$|(^|[_-])bot([_-]|$)/i;

/** A host bot account, a `…[bot]` login, a GitLab project/group bot, or a login the config names. */
export function isBotLogin(login: string | null, extra: string[], hostSaysBot = false): boolean {
    if (hostSaysBot) {
        return true;
    }

    if (!login) {
        return false;
    }

    return BOT_NAME.test(login) || extra.some((name) => name.toLowerCase() === login.toLowerCase());
}
