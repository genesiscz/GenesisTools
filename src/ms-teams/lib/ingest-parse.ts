import { parseAttachments, parseLinks, parseMentions, parseReactions } from "./attachments";
import { decodeTeamsString } from "./decode";
import { htmlToText } from "./html-to-text";
import type { ConversationType, Person } from "./types";

export interface ParsedConversation {
    id: string;
    type: ConversationType;
    title: string;
    topic: string | null;
    members: Person[];
    lastMessageTime: number | null;
    lastPreview: string | null;
    raw: unknown;
}

export interface ParsedMessage {
    id: string;
    conversationId: string;
    sequenceId: number | null;
    version: number;
    originalArrivalTime: number;
    fromMri: string | null;
    fromName: string | null;
    isFromMe: boolean;
    messageType: string;
    text: string;
    html: string | null;
    replyToId: string | null;
    reactions: { emotion: string; count: number }[];
    mentions: { id: string; name: string }[];
    links: string[];
    attachments: ReturnType<typeof parseAttachments>;
    raw: unknown;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    return null;
}

export function mapConversationType(raw: unknown): ConversationType {
    const t = decodeTeamsString(raw).toLowerCase();

    if (t === "meeting") {
        return "meeting";
    }

    if (t === "chat" || t === "oneonone" || t === "personal") {
        return "chat";
    }

    if (t === "space") {
        return "space";
    }

    if (t === "topic") {
        return "topic";
    }

    return "other";
}

export function parseConversation(raw: unknown): ParsedConversation | null {
    const rec = asRecord(raw);

    if (!rec) {
        return null;
    }

    const id = decodeTeamsString(rec.id);

    if (!id) {
        return null;
    }

    const chatTitle = asRecord(rec.chatTitle);
    const threadProps = asRecord(rec.threadProperties);
    const title = decodeTeamsString(chatTitle?.shortTitle ?? threadProps?.topic ?? rec.id);
    const topic = decodeTeamsString(threadProps?.topic) || null;
    const members = parseMembers(rec.members, chatTitle);
    const lastMessage = asRecord(rec.lastMessage);
    const lastPreview = htmlToText(lastMessage?.content).text || decodeTeamsString(lastMessage?.content) || null;
    const lastMessageTime = numberish(rec.lastMessageTimeUtc ?? rec.lastContentMessageTime ?? rec.clientArrivalTime);

    return {
        id,
        type: mapConversationType(rec.type),
        title: title || id,
        topic,
        members,
        lastMessageTime,
        lastPreview,
        raw,
    };
}

export function parseMembers(membersRaw: unknown, chatTitle: Record<string, unknown> | null): Person[] {
    const byMri = new Map<string, Person>();
    const avatars = chatTitle?.avatarUsersInfo;
    const avatarList = Array.isArray(avatars) ? avatars : [];

    for (const avatar of avatarList) {
        const rec = asRecord(avatar);

        if (!rec) {
            continue;
        }

        const mri = decodeTeamsString(rec.mri ?? rec.id);

        if (!mri) {
            continue;
        }

        byMri.set(mri, {
            mri,
            displayName: decodeTeamsString(rec.displayName) || mri,
            email: decodeTeamsString(rec.email) || null,
        });
    }

    const members = Array.isArray(membersRaw) ? membersRaw : [];

    for (const member of members) {
        const rec = asRecord(member);

        if (!rec) {
            continue;
        }

        const mri = decodeTeamsString(rec.id ?? rec.mri);

        if (!mri) {
            continue;
        }

        const existing = byMri.get(mri);
        const name = decodeTeamsString(rec.friendlyName ?? rec.displayName);

        byMri.set(mri, {
            mri,
            displayName: existing?.displayName || name || mri,
            email: existing?.email ?? (decodeTeamsString(rec.email) || null),
        });
    }

    return [...byMri.values()];
}

export function parseReplychain(raw: unknown, meMri: string | null): ParsedMessage[] {
    const rec = asRecord(raw);

    if (!rec) {
        return [];
    }

    const conversationId = decodeTeamsString(rec.conversationId);
    const mmap = asRecord(rec.messageMap);

    if (!conversationId || !mmap) {
        return [];
    }

    const out: ParsedMessage[] = [];

    for (const value of Object.values(mmap)) {
        const parsed = parseMessage(value, conversationId, meMri);

        if (parsed) {
            out.push(parsed);
        }
    }

    return out;
}

export function parseMessage(raw: unknown, conversationId: string, meMri: string | null): ParsedMessage | null {
    const rec = asRecord(raw);

    if (!rec) {
        return null;
    }

    const id = decodeTeamsString(rec.id);

    if (!id) {
        return null;
    }

    const html = decodeTeamsString(rec.content) || null;
    const extracted = htmlToText(html ?? "");
    const parent = decodeTeamsString(rec.parentMessageId);
    const replyToId = parent && parent !== id ? parent : extracted.replyToId;
    const fromMri = decodeTeamsString(rec.creator) || null;
    const fromName = decodeTeamsString(rec.imDisplayName) || decodeTeamsString(rec.fromDisplayNameInToken) || fromMri;
    const isSent = rec.isSentByCurrentUser === true || rec.isSentByCurrentUser === "true";
    const originalArrivalTime = numberish(rec.originalArrivalTime) ?? numberish(rec.clientArrivalTime) ?? 0;
    const messageType = decodeTeamsString(rec.messageType ?? rec.type) || "Message";

    if (!originalArrivalTime) {
        return null;
    }

    return {
        id,
        conversationId: decodeTeamsString(rec.conversationId) || conversationId,
        sequenceId: numberish(rec.sequenceId),
        version: numberish(rec.version) ?? originalArrivalTime,
        originalArrivalTime,
        fromMri,
        fromName,
        isFromMe: isSent || (meMri !== null && fromMri === meMri),
        messageType,
        text: extracted.text,
        html,
        replyToId,
        reactions: parseReactions(rec.annotationsSummary),
        mentions: parseMentions(rec.properties),
        links: parseLinks(rec.properties),
        attachments: parseAttachments(rec.properties, html),
        raw,
    };
}

export function parseProfile(raw: unknown): Person | null {
    const rec = asRecord(raw);

    if (!rec) {
        return null;
    }

    const mri = decodeTeamsString(rec.mri ?? rec.objectId);

    if (!mri) {
        return null;
    }

    return {
        mri: mri.startsWith("8:") ? mri : `8:orgid:${mri}`,
        displayName: decodeTeamsString(rec.displayName) || mri,
        email: decodeTeamsString(rec.email ?? rec.userPrincipalName) || null,
    };
}

export function numberish(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value !== "" && value !== "<Undefined>") {
        const n = Number(value);

        if (Number.isFinite(n)) {
            return n;
        }
    }

    return null;
}

export function isSystemMessageType(messageType: string): boolean {
    return messageType.startsWith("ThreadActivity/") || messageType === "Event/Call";
}
