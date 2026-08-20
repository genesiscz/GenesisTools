export type ConversationType = "meeting" | "chat" | "space" | "topic" | "other";

export interface Person {
    mri: string;
    displayName: string;
    email: string | null;
}

export interface Attachment {
    name: string;
    mimeHint: string | null;
    url: string | null;
    itemId: string | null;
    localPath: string | null;
}

export interface Reaction {
    emotion: string;
    count: number;
}

export interface Mention {
    id: string;
    name: string;
}

export interface ExportedMessage {
    id: string;
    sequenceId: number | null;
    time: string;
    from: Person;
    isFromMe: boolean;
    messageType: string;
    text: string;
    html: string | null;
    replyToId: string | null;
    replyTo: { id: string; from: string; excerpt: string } | null;
    reactions: Reaction[];
    mentions: Mention[];
    links: string[];
    attachments: Attachment[];
    call: { state: string; durationSec?: number } | null;
    system: string | null;
}

export interface ThreadExport {
    conversation: {
        id: string;
        type: ConversationType;
        title: string;
        topic: string | null;
        members: Person[];
        cachedFrom: string | null;
        cachedTo: string | null;
        messageCount: number;
        completenessNote: string;
    };
    messages: ExportedMessage[];
}

export interface ConversationRow {
    id: string;
    type: ConversationType;
    title: string;
    topic: string | null;
    membersJson: string;
    lastMessageTime: number | null;
    lastPreview: string | null;
    memberCount: number;
}

export interface MessageRow {
    id: string;
    conversationId: string;
    sequenceId: number | null;
    version: number | null;
    originalArrivalTime: number;
    fromMri: string | null;
    fromName: string | null;
    isFromMe: boolean;
    messageType: string;
    text: string;
    html: string | null;
    replyToId: string | null;
    reactionsJson: string;
    mentionsJson: string;
    linksJson: string;
    attachmentsJson: string;
}

export interface PeopleRow {
    mri: string;
    displayName: string;
    email: string | null;
    upn: string | null;
}

export interface CallRow {
    id: string;
    startTime: string | null;
    endTime: string | null;
    callType: string | null;
    callState: string | null;
    callDirection: string | null;
    threadId: string | null;
    summary: string;
}

export interface ActivityRow {
    id: string;
    activityType: string;
    activitySubtype: string | null;
    sourceThreadId: string | null;
    sourceMessageId: string | null;
    timestamp: number | null;
}

export interface ListConversationsOptions {
    type?: ConversationType | "group";
    withName?: string;
    topic?: string;
    from?: Date;
    to?: Date;
    limit?: number;
}

export interface ListMessagesOptions {
    from?: Date;
    to?: Date;
    includeSystem?: boolean;
}

export const COMPLETENESS_NOTE = "client cache of opened threads; not a server-complete history";

export interface TeamsDump {
    conversations: unknown[];
    replychains: unknown[];
    profiles: unknown[];
    calls: unknown[];
    activity: unknown[];
}
