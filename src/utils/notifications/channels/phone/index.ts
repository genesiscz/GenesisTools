import { logger } from "@genesiscz/utils/logger";
import { type DeskPresence, readDeskPresence } from "@genesiscz/utils/macos/desk-presence";
import {
    answerCategoryId,
    MAX_ANSWER_LETTERS,
    PUSH_DATA_KEY,
    type PushNoticeData,
    type PushRetractData,
    type SealedBox,
} from "../../phone-wire";
import type { ChannelDefinition, NotificationEvent, PhoneChannelConfig } from "../../types";
import { filePhoneDeviceStore, type PhoneDevice, type PhoneDeviceStore, type PhoneRoute } from "./devices";
import { loadPushKeys, type PushKeyPair, sealForDevice } from "./seal";
import { PUSH_TRANSPORTS, type PushMessage, type PushResult, type PushTransportTable } from "./transports";
import { phoneHold } from "./when";

const log = logger.child({ component: "notifications:phone" });

/** What the lock screen shows when the channel keeps decision text off the phone (`text: false`). */
export const TEXT_OFF_BODY = "Open GenesisTools to read it.";

/** The alert of one event for one device; `sealed` holds the answer tokens when the event carries answers. */
export function alertPayload({
    event,
    config,
    sealed,
}: {
    event: NotificationEvent;
    config: PhoneChannelConfig;
    sealed?: SealedBox;
}): Record<string, unknown> {
    const answers = event.phone?.answers;
    const letters = answers && answers.letters.length <= MAX_ANSWER_LETTERS && sealed ? answers.letters : undefined;
    const data: PushNoticeData = {
        v: 1,
        kind: "notice",
        ...(event.id ? { noticeId: event.id } : {}),
        ...(letters && sealed ? { letters, sealed } : {}),
    };

    return {
        aps: {
            alert: {
                title: event.title ?? "GenesisTools",
                ...(event.subtitle ? { subtitle: event.subtitle } : {}),
                body: config.text === false ? TEXT_OFF_BODY : event.message,
            },
            sound: "default",
            ...(event.phone?.thread ? { "thread-id": event.phone.thread } : {}),
            ...(letters ? { category: answerCategoryId(letters.length, answers?.recommended) } : {}),
            "interruption-level": event.timeSensitive ? "time-sensitive" : "active",
        },
        [PUSH_DATA_KEY]: data,
    };
}

/** The silent push that takes notices off the lock screen. */
export function retractPayload(noticeIds: string[]): Record<string, unknown> {
    const data: PushRetractData = { v: 1, kind: "retract", noticeIds };
    return { aps: { "content-available": 1 }, [PUSH_DATA_KEY]: data };
}

export interface PhoneChannelDeps {
    devices: PhoneDeviceStore;
    transports: PushTransportTable;
    keys: () => Promise<PushKeyPair>;
    /** Whether someone sits at the Mac (F14 desk mode); `readDeskPresence` when omitted. */
    presence?: () => Promise<DeskPresence>;
}

function send(transports: PushTransportTable, device: PhoneDevice, message: PushMessage, config: PhoneChannelConfig) {
    const route: PhoneRoute = device.route;

    // An exhaustive table keyed by the route kind; the narrowing below is the type system's, not a name branch.
    return route.kind === "apns"
        ? transports.apns.send(route, { ...message, topic: config.apns?.topic ?? message.topic }, config.apns)
        : transports.simctl.send(route, message, config.apns);
}

function sameRoute(a: PhoneRoute, b: PhoneRoute): boolean {
    if (a.kind === "apns" && b.kind === "apns") {
        return a.token === b.token && a.environment === b.environment;
    }
    return a.kind === "simctl" && b.kind === "simctl" && a.udid === b.udid;
}

/**
 * Sends to one device, and keeps the registry true to what Apple answered: a token from the other environment is
 * retried there once and remembered, and an unregistered device is dropped.
 */
async function sendToDevice({
    deps,
    device,
    message,
    config,
}: {
    deps: PhoneChannelDeps;
    device: PhoneDevice;
    message: PushMessage;
    config: PhoneChannelConfig;
}): Promise<PushResult> {
    let result = await send(deps.transports, device, message, config);

    if (!result.ok && result.otherEnvironment && device.route.kind === "apns") {
        const flipped: PhoneDevice = {
            ...device,
            route: {
                ...device.route,
                environment: device.route.environment === "production" ? "sandbox" : "production",
            },
        };
        result = await send(deps.transports, flipped, message, config);

        if (result.ok) {
            await deps.devices.update((devices) => {
                const current = devices[device.id];
                if (current && current.seenAt === device.seenAt && sameRoute(current.route, device.route)) {
                    devices[device.id] = { ...current, route: flipped.route };
                }
            });
        }
    }

    if (!result.ok && result.gone) {
        log.info({ device: device.id, reason: result.reason }, "a phone unregistered; it is dropped");
        await deps.devices.update((devices) => {
            const current = devices[device.id];
            if (current && current.seenAt === device.seenAt && sameRoute(current.route, device.route)) {
                delete devices[device.id];
            }
        });
    }

    return result;
}

/** The phone channel over its device store, transports and push keys; tests pass fakes of all three. */
export function createPhoneChannel(deps: PhoneChannelDeps): ChannelDefinition<"phone"> {
    return {
        name: "phone",
        label: "Phone (push)",
        defaults: { enabled: false, text: true },
        fields: { enabled: "boolean", text: "boolean" },
        secretKeys: [],
        unusable: () => (deps.devices.list().length > 0 ? undefined : "no phone registered (open the app once)"),
        describe(config) {
            const devices = deps.devices.list();
            const names = devices.map((device) => `${device.name} (${device.route.kind})`).join(", ");
            return `${names || "no phone"}${config.text === false ? " · text off" : ""}`;
        },
        async post(event, config) {
            if (!config.enabled) {
                return { ok: true };
            }

            const devices = deps.devices.list();

            if (devices.length === 0) {
                return { ok: true, detail: "no phone registered" };
            }

            const hold = await phoneHold({ event, when: config.when, presence: deps.presence ?? readDeskPresence });

            if (hold) {
                // Skipped, not queued: the Mac's banner shows it, and the phone does not get it later.
                log.info({ id: event.id, hold }, "phone alert skipped");
                return { ok: true, suppressed: hold, detail: `skipped, not sent later: ${hold}` };
            }

            try {
                const answers = event.phone?.answers;
                const keys = answers ? await deps.keys() : undefined;
                const results = await Promise.all(
                    devices.map(async (device) => {
                        const sealed =
                            answers && keys
                                ? sealForDevice({ tokens: answers.tokens }, device.publicKey, keys)
                                : undefined;
                        const message: PushMessage = {
                            payload: alertPayload({ event, config, ...(sealed ? { sealed } : {}) }),
                            pushType: "alert",
                            priority: 10,
                            topic: device.bundleId,
                            ...(event.id ? { collapseId: event.id } : {}),
                        };
                        const result = await sendToDevice({ deps, device, message, config });
                        return { device, result };
                    })
                );
                const failed = results.filter(({ result }) => !result.ok);

                for (const { device, result } of failed) {
                    log.warn({ device: device.id, reason: !result.ok ? result.reason : undefined }, "push not sent");
                }

                return {
                    ok: failed.length === 0,
                    detail: results
                        .map(({ device, result }) => `${device.name}: ${result.ok ? "sent" : result.reason}`)
                        .join("; "),
                };
            } catch (err) {
                log.warn({ err }, "phone push failed");
                return { ok: false, detail: err instanceof Error ? err.message : String(err) };
            }
        },
        async retract(noticeId, config) {
            const devices = deps.devices.list();

            if (devices.length === 0) {
                return false;
            }

            try {
                const results = await Promise.all(
                    devices.map((device) =>
                        sendToDevice({
                            deps,
                            device,
                            message: {
                                payload: retractPayload([noticeId]),
                                pushType: "background",
                                priority: 5,
                                topic: device.bundleId,
                            },
                            config,
                        })
                    )
                );
                return results.some((result) => result.ok);
            } catch (err) {
                log.warn({ err, noticeId }, "phone retraction failed");
                return false;
            }
        },
    };
}

export const phoneChannel = createPhoneChannel({
    devices: filePhoneDeviceStore(),
    transports: PUSH_TRANSPORTS,
    keys: () => loadPushKeys(),
});

import { SafeJSON } from "@genesiscz/utils/json";
