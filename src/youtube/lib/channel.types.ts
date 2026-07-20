import type { PipelineJob } from "@app/youtube/lib/jobs.types";

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

export type ChannelSyncStatus = "idle" | "queued" | "running" | "synced" | "failed";

/** Response for GET /api/v1/channels/:handle (write-on-GET ensure). */
export interface ChannelEnsureResult {
    channel: Channel;
    tracked: boolean;
    syncStatus: ChannelSyncStatus;
    job: PipelineJob | null;
    queuePosition: number | null;
    reused: boolean;
}
