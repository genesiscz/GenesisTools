import type { Notification } from "@app/shops/db/NotificationsRepository";

export type NotificationChannelName = "macos" | "web" | "telegram";

export interface NotificationPayload {
    notification: Notification;
    title: string;
    body: string;
    detailUrl: string;
    buyUrl: string | null;
}

export interface DispatchResult {
    channel: NotificationChannelName;
    delivered: boolean;
    error?: string;
}

export interface NotificationChannel {
    readonly name: NotificationChannelName;
    available(): boolean;
    dispatch(payload: NotificationPayload): Promise<DispatchResult>;
}
