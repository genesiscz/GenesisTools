export type ChannelHandle = `@${string}`;

export interface Channel {
    handle: ChannelHandle;
    channelId: string | null;
    title: string | null;
    description: string | null;
    subscriberCount: number | null;
    thumbUrl: string | null;
    lastSyncedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
