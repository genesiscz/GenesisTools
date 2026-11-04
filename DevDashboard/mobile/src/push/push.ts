import {
    type ActReceiptDto,
    answerActionId,
    answerCategories,
    type DashboardClient,
    ENDPOINTS,
    letterOfAction,
    type PushDeviceRegistration,
} from "@dd/contract";
import * as Application from "expo-application";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { defaultDatabaseDirectory } from "expo-sqlite";
import * as TaskManager from "expo-task-manager";
import { openSealed, pushIdentity, rememberMacKey } from "@/push/push-keys";
import { noticeDataOf, pushDataOf } from "@/push/wire";
import { useConnectionStore } from "@/state/connection-store";

/** The task iOS runs for a silent push (a retraction) while the app is in the background. */
export const PUSH_TASK = "gt-push-background";

/** A notice shown in the foreground still shows as a banner: it is what the user asked to be told. */
function showWhileOpen(): void {
    Notifications.setNotificationHandler({
        handleNotification: async () => ({
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
        }),
    });
}

/** One category per answer shape (1 to 6 letters, one recommended letter marked), each button answering in place. */
async function registerCategories(): Promise<void> {
    await Promise.all(
        answerCategories().map((category) =>
            Notifications.setNotificationCategoryAsync(
                category.id,
                category.letters.map((letter) => ({
                    identifier: answerActionId(letter),
                    buttonTitle: letter === category.recommended ? `${letter} ★` : letter,
                    // The answer runs without opening the app; the receipt comes back as a notice.
                    options: { opensAppToForeground: false },
                }))
            )
        )
    );
}

/**
 * A simulator has no APNs token; `xcrun simctl push` reaches it by its id, which names the folder the app's data lives
 * in (`…/CoreSimulator/Devices/<udid>/data/…`).
 */
function simulatorUdid(): string | null {
    const match = /CoreSimulator\/Devices\/([0-9A-F-]{36})\//i.exec(String(defaultDatabaseDirectory ?? ""));
    return match ? match[1] : null;
}

/**
 * Asks for notification permission once, then registers this install with the connected Mac: its APNs token (or its
 * simulator id) and its push key. Runs on every start, so a new token or a new Mac is picked up. Returns why it could
 * not register, or null when it did.
 */
export async function registerForPush(client: DashboardClient): Promise<string | null> {
    const permission = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: true },
    });

    if (!permission.granted) {
        return "notifications are not allowed for this app";
    }

    const identity = await pushIdentity();
    const bundleId = Application.applicationId;

    if (!bundleId) {
        return "this build has no bundle id";
    }

    let route: Pick<PushDeviceRegistration, "apns" | "simulator">;

    if (Device.isDevice) {
        const token = await Notifications.getDevicePushTokenAsync();
        route = { apns: { token: String(token.data) } };
    } else {
        const udid = simulatorUdid();

        if (!udid) {
            return "this simulator's id could not be read";
        }

        route = { simulator: { udid } };
    }

    const receipt = await client.call(
        ENDPOINTS.pushRegister,
        {
            id: identity.id,
            name: Device.deviceName ?? Device.modelName ?? "iPhone",
            bundleId,
            publicKey: identity.publicKey,
            ...route,
        },
        { idempotencyKey: `push-register-${identity.id}-${Date.now()}` }
    );
    await rememberMacKey(receipt.macPublicKey);
    return null;
}

/** The dashboard client of the active connection; a background launch waits for the root layout's restore. */
async function activeClient(): Promise<DashboardClient | null> {
    const state = useConnectionStore.getState();

    if (!state.restored) {
        await new Promise<void>((resolve) => {
            const stop = useConnectionStore.subscribe((next) => {
                if (next.restored) {
                    stop();
                    resolve();
                }
            });
            // The layout normally restores; with no React tree yet, restore here.
            setTimeout(() => {
                if (!useConnectionStore.getState().restored) {
                    void useConnectionStore.getState().restore();
                }
            }, 3000);
        });
    }

    return useConnectionStore.getState().transport?.client() ?? null;
}

function receiptLine(letter: string, receipt: ActReceiptDto): string {
    const what = receipt.decision ? `DECISION ${receipt.decision.number} → ${letter}` : `Answer ${letter}`;
    const outcome = receipt.outcome;
    return outcome.kind === "refused" ? `${what} refused: ${outcome.detail}` : `${what}: ${outcome.kind}`;
}

async function tell(title: string, body: string): Promise<void> {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
}

/**
 * A press of an answer button: opens the sealed tokens, answers through the act door with the token of the pressed
 * letter, and shows the receipt as a notice. The idempotency key is the notification and the letter, so a press iOS
 * delivers twice (once live, once as the last response) answers once.
 */
export async function answerFromNotification(response: Notifications.NotificationResponse): Promise<void> {
    const letter = letterOfAction(response.actionIdentifier);

    if (!letter) {
        return;
    }

    const data = noticeDataOf(response.notification);

    if (!data || data.kind !== "notice" || !data.sealed) {
        return;
    }

    const secrets = await openSealed(data.sealed);
    const token = secrets?.tokens[letter];

    if (!token) {
        await tell("Not answered", "This button was sealed for another phone or Mac. Answer in the app.");
        return;
    }

    const client = await activeClient();

    if (!client) {
        await tell("Not answered", "No Mac is connected. Open the app and answer there.");
        return;
    }

    try {
        const receipt = await client.call(ENDPOINTS.act, {}, {
            actToken: token,
            idempotencyKey: `push:${response.notification.request.identifier}:${letter}`,
        });
        await tell("GenesisTools", receiptLine(letter, receipt));
    } catch (err) {
        await tell("Not answered", err instanceof Error ? err.message : String(err));
    }
}

/** Takes the notices a retraction names off the lock screen and out of the list. */
export async function retractNotices(noticeIds: readonly string[]): Promise<number> {
    const wanted = new Set(noticeIds);
    const shown = await Notifications.getPresentedNotificationsAsync();
    const gone = shown.filter((notification) => {
        const data = noticeDataOf(notification);
        return data?.kind === "notice" && data.noticeId !== undefined && wanted.has(data.noticeId);
    });
    await Promise.all(gone.map((notification) => Notifications.dismissNotificationAsync(notification.request.identifier)));
    return gone.length;
}

TaskManager.defineTask(PUSH_TASK, async ({ data }) => {
    const payload = pushDataOf((data as { data?: unknown } | undefined)?.data);

    if (payload?.kind === "retract") {
        await retractNotices(payload.noticeIds);
        return Notifications.BackgroundNotificationTaskResult.NewData;
    }

    return Notifications.BackgroundNotificationTaskResult.NoData;
});

let started = false;

/**
 * Wires push at module scope, before React mounts, because an answer button pressed on the lock screen launches the
 * app in the background and its response must find a listener. Safe to call twice.
 */
export function startPush(): void {
    if (started) {
        return;
    }

    started = true;
    showWhileOpen();
    void registerCategories().catch((err: unknown) => console.warn("[push] categories", err));
    void Notifications.registerTaskAsync(PUSH_TASK).catch((err: unknown) => console.warn("[push] task", err));

    Notifications.addNotificationResponseReceivedListener((response) => {
        void answerFromNotification(response).catch((err: unknown) => console.warn("[push] answer", err));
    });
    // A press that launched the app came before the listener existed.
    const last = Notifications.getLastNotificationResponse();

    if (last) {
        Notifications.clearLastNotificationResponse();
        void answerFromNotification(last).catch((err: unknown) => console.warn("[push] answer", err));
    }

    // A foreground silent push (a retraction while the app is open) reaches this listener, not the task.
    Notifications.addNotificationReceivedListener((notification) => {
        const data = noticeDataOf(notification);

        if (data?.kind === "retract") {
            void retractNotices(data.noticeIds);
        }
    });
}
