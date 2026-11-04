import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import nacl from "tweetnacl";
import {
    answerCategories,
    answerCategoryId,
    letterOfAction,
    PUSH_DATA_KEY,
    type PushNoticeData,
    REPLY_ACTION_ID,
} from "../../phone-wire";
import type { NotificationEvent } from "../../types";
import { memoryPhoneDeviceStore, type PhoneDevice, type PhoneRoute, registerPhoneDevice } from "./devices";
import { createPhoneChannel, retractPayload, TEXT_OFF_BODY } from "./index";
import { openOnDevice, type PushKeyPair } from "./seal";
import type { PushMessage, PushResult, PushTransportTable } from "./transports";

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function keyPair(): PushKeyPair {
    const pair = nacl.box.keyPair();
    return { publicKey: base64(pair.publicKey), secretKey: base64(pair.secretKey) };
}

interface Sent {
    route: PhoneRoute;
    message: PushMessage;
}

/** A transport table that records every push and answers from `answer` (default: accepted). */
function fakeTransports(answer: (route: PhoneRoute) => PushResult = () => ({ ok: true })) {
    const sent: Sent[] = [];
    const record = (route: PhoneRoute, message: PushMessage) => {
        sent.push({ route, message });
        return Promise.resolve(answer(route));
    };
    const transports: PushTransportTable = { apns: { send: record }, simctl: { send: record } };
    return { sent, transports };
}

const phoneKeys = keyPair();
const macKeys = keyPair();

function device(route: PhoneRoute, id = "phone-1"): PhoneDevice {
    return {
        id,
        name: "Test phone",
        bundleId: "dev.example.app",
        publicKey: phoneKeys.publicKey,
        route,
        registeredAt: "2026-11-04T10:00:00.000Z",
        seenAt: "2026-11-04T10:00:00.000Z",
    };
}

const decisionEvent: NotificationEvent = {
    app: "question",
    title: "❓ DECISION 3: Pick a cache",
    message: "Which cache?\na) memory\nb) disk",
    id: "qa-decision-d3",
    timeSensitive: true,
    phone: {
        thread: "session-1",
        answers: { letters: ["a", "b"], recommended: "b", tokens: { a: "tok-a", b: "tok-b" } },
    },
};

describe("phone channel", () => {
    test("an alert carries the answer category and tokens only the device opens", async () => {
        const store = memoryPhoneDeviceStore({ "phone-1": device({ kind: "simctl", udid: "SIM-1" }) });
        const { sent, transports } = fakeTransports();
        const channel = createPhoneChannel({ devices: store, transports, keys: async () => macKeys });

        const receipt = await channel.post(decisionEvent, { enabled: true });

        expect(receipt.ok).toBe(true);
        expect(sent).toHaveLength(1);
        const { message } = sent[0];
        expect(message).toMatchObject({
            pushType: "alert",
            priority: 10,
            topic: "dev.example.app",
            collapseId: "qa-decision-d3",
        });
        const aps = message.payload.aps as Record<string, unknown>;
        expect(aps.category).toBe(answerCategoryId(2, "b"));
        expect(aps["interruption-level"]).toBe("time-sensitive");
        expect(aps["thread-id"]).toBe("session-1");
        const data = message.payload[PUSH_DATA_KEY] as PushNoticeData;
        expect(data.letters).toEqual(["a", "b"]);
        expect(SafeJSON.stringify(message.payload)).not.toContain("tok-a");
        expect(openOnDevice(data.sealed!, macKeys.publicKey, phoneKeys.secretKey)).toEqual({
            tokens: { a: "tok-a", b: "tok-b" },
        });
        expect(openOnDevice(data.sealed!, macKeys.publicKey, keyPair().secretKey)).toBeNull();
    });

    test("text off keeps the message off the lock screen", async () => {
        const store = memoryPhoneDeviceStore({ "phone-1": device({ kind: "simctl", udid: "SIM-1" }) });
        const { sent, transports } = fakeTransports();
        const channel = createPhoneChannel({ devices: store, transports, keys: async () => macKeys });

        await channel.post(decisionEvent, { enabled: true, text: false });

        const alert = (sent[0].message.payload.aps as { alert: { body: string } }).alert;
        expect(alert.body).toBe(TEXT_OFF_BODY);
    });

    test("a switched-off channel sends nothing", async () => {
        const store = memoryPhoneDeviceStore({ "phone-1": device({ kind: "simctl", udid: "SIM-1" }) });
        const { sent, transports } = fakeTransports();
        const channel = createPhoneChannel({ devices: store, transports, keys: async () => macKeys });

        expect(await channel.post(decisionEvent, { enabled: false })).toEqual({ ok: true });
        expect(sent).toHaveLength(0);
    });

    test("a token from the other APNs environment is retried there once and remembered", async () => {
        const store = memoryPhoneDeviceStore({
            "phone-1": device({ kind: "apns", token: "abc", environment: "production" }),
        });
        const { sent, transports } = fakeTransports((route) =>
            route.kind === "apns" && route.environment === "production"
                ? { ok: false, reason: "BadDeviceToken", otherEnvironment: true }
                : { ok: true }
        );
        const channel = createPhoneChannel({ devices: store, transports, keys: async () => macKeys });

        expect((await channel.post(decisionEvent, { enabled: true })).ok).toBe(true);
        expect(sent.map(({ route }) => route.kind === "apns" && route.environment)).toEqual(["production", "sandbox"]);
        expect(store.devices["phone-1"].route).toEqual({ kind: "apns", token: "abc", environment: "sandbox" });
    });

    test("an unregistered device is dropped", async () => {
        const store = memoryPhoneDeviceStore({ "phone-1": device({ kind: "simctl", udid: "SIM-GONE" }) });
        const { transports } = fakeTransports(() => ({ ok: false, reason: "Invalid device", gone: true }));
        const channel = createPhoneChannel({ devices: store, transports, keys: async () => macKeys });

        expect((await channel.post(decisionEvent, { enabled: true })).ok).toBe(false);
        expect(store.devices).toEqual({});
    });

    test("retract sends a silent push that names the notice, to every device", async () => {
        const store = memoryPhoneDeviceStore({
            "phone-1": device({ kind: "simctl", udid: "SIM-1" }),
            "phone-2": device({ kind: "apns", token: "t2", environment: "sandbox" }, "phone-2"),
        });
        const { sent, transports } = fakeTransports();
        const channel = createPhoneChannel({ devices: store, transports, keys: async () => macKeys });

        expect(await channel.retract("qa-decision-d3", { enabled: false })).toBe(true);
        expect(sent).toHaveLength(2);
        expect(sent[0].message).toMatchObject({
            pushType: "background",
            priority: 5,
            payload: retractPayload(["qa-decision-d3"]),
        });
    });

    test("unusable until a phone registers", async () => {
        const store = memoryPhoneDeviceStore();
        const channel = createPhoneChannel({
            devices: store,
            transports: fakeTransports().transports,
            keys: async () => macKeys,
        });

        expect(channel.unusable({ enabled: true })).toContain("no phone");
        await registerPhoneDevice(store, {
            id: "phone-1",
            name: "Test phone",
            bundleId: "dev.example.app",
            publicKey: phoneKeys.publicKey,
            simulator: { udid: "SIM-1" },
        });
        expect(channel.unusable({ enabled: true })).toBeUndefined();
    });

    test("a re-registration keeps the learned APNs environment and the first date", async () => {
        const store = memoryPhoneDeviceStore({
            "phone-1": device({ kind: "apns", token: "abc", environment: "sandbox" }),
        });
        const again = await registerPhoneDevice(
            store,
            {
                id: "phone-1",
                name: "Renamed",
                bundleId: "dev.example.app",
                publicKey: phoneKeys.publicKey,
                apns: { token: "abc" },
            },
            new Date("2026-11-05T08:00:00.000Z")
        );

        expect(again.route).toEqual({ kind: "apns", token: "abc", environment: "sandbox" });
        expect(again.registeredAt).toBe("2026-11-04T10:00:00.000Z");
        expect(again.name).toBe("Renamed");
    });
});

describe("phone wire", () => {
    test("one category per letter count and recommended letter, and the action ids round-trip", () => {
        const ids = answerCategories().map((category) => category.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain("gt-answer-3-c");
        expect(answerCategoryId(2, "z")).toBe("gt-answer-2");
        expect(letterOfAction("answer:b")).toBe("b");
        expect(letterOfAction(REPLY_ACTION_ID)).toBeNull();
        expect(letterOfAction("com.apple.UNNotificationDefaultActionIdentifier")).toBeNull();
    });
});
