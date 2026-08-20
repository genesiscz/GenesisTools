import { foldTeamsText } from "./decode";
import type { ShowQuery } from "./query";
import { isOneToOneId, type TeamsCache } from "./store";
import type { ConversationRow } from "./types";

export type ResolveResult =
    | { status: "exact"; conversation: ConversationRow }
    | { status: "ambiguous"; matches: ConversationRow[] }
    | { status: "none"; matches: ConversationRow[] };

interface Scored {
    conversation: ConversationRow;
    score: number;
}

export function resolveConversation(cache: TeamsCache, query: ShowQuery): ResolveResult {
    if (query.id) {
        const found = cache.getConversation(query.id);

        if (found) {
            return { status: "exact", conversation: found };
        }

        return { status: "none", matches: [] };
    }

    const all = cache.listConversations({ limit: 10_000 });
    const scored: Scored[] = [];
    const nameFold = query.withName ? foldTeamsText(query.withName) : "";
    const topicFold = query.topic ? foldTeamsText(query.topic) : "";

    for (const conversation of all) {
        const score = scoreConversation(conversation, nameFold, topicFold);

        if (score > 0) {
            scored.push({ conversation, score });
        }
    }

    scored.sort(
        (a, b) => b.score - a.score || (b.conversation.lastMessageTime ?? 0) - (a.conversation.lastMessageTime ?? 0)
    );

    if (scored.length === 0) {
        return { status: "none", matches: [] };
    }

    const best = scored[0];
    const tied = scored.filter((s) => s.score === best.score);

    if (nameFold) {
        const oneToOnes = scored.filter((s) => isOneToOneId(s.conversation.id, s.conversation.title) && s.score >= 80);

        if (oneToOnes.length === 1) {
            return { status: "exact", conversation: oneToOnes[0].conversation };
        }

        if (oneToOnes.length > 1) {
            return { status: "ambiguous", matches: oneToOnes.map((s) => s.conversation) };
        }
    }

    if (tied.length === 1 && best.score >= 50) {
        return { status: "exact", conversation: best.conversation };
    }

    if (tied.length > 1) {
        return { status: "ambiguous", matches: tied.map((s) => s.conversation) };
    }

    if (best.score >= 50) {
        return { status: "exact", conversation: best.conversation };
    }

    return { status: "none", matches: scored.slice(0, 8).map((s) => s.conversation) };
}

function scoreConversation(conversation: ConversationRow, nameFold: string, topicFold: string): number {
    const title = foldTeamsText(conversation.title);
    const topic = foldTeamsText(conversation.topic);
    const members = foldTeamsText(conversation.membersJson);
    const oneToOne = isOneToOneId(conversation.id, conversation.title);
    let score = 0;

    if (nameFold) {
        if (title === nameFold) {
            score += oneToOne ? 100 : 70;
        } else if (title.includes(nameFold)) {
            score += oneToOne ? 90 : 55;
        } else if (members.includes(nameFold) || topic.includes(nameFold)) {
            score += oneToOne ? 80 : 45;
        } else {
            return 0;
        }
    }

    if (topicFold) {
        if (title === topicFold || topic === topicFold) {
            score += 100;
        } else if (title.includes(topicFold) || topic.includes(topicFold)) {
            score += 70;
        } else if (!nameFold) {
            return 0;
        }
    }

    if (!nameFold && !topicFold) {
        return 0;
    }

    return score;
}
