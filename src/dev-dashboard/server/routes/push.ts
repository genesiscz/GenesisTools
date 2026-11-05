import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { bindEndpoint } from "@app/dev-dashboard/server/bind";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { type ChannelReceipt, notificationsConfig } from "@genesiscz/utils/notifications";
import { createPhoneChannel } from "@genesiscz/utils/notifications/channels/phone";
import {
    filePhoneDeviceStore,
    type PhoneDeviceStore,
    registerPhoneDevice,
    removePhoneDevice,
} from "@genesiscz/utils/notifications/channels/phone/devices";
import { loadPushKeys, type PushKeyPair } from "@genesiscz/utils/notifications/channels/phone/seal";
import { PUSH_TRANSPORTS, type PushTransportTable } from "@genesiscz/utils/notifications/channels/phone/transports";
import { z } from "zod";

export interface PushRouteDeps {
    devices: PhoneDeviceStore;
    keys: () => Promise<PushKeyPair>;
    transports: PushTransportTable;
}

const registration = z
    .object({
        id: z.string().min(8).max(128),
        name: z.string().min(1).max(120),
        bundleId: z.string().min(3).max(200),
        publicKey: z
            .string()
            .refine(
                (value) =>
                    /^[A-Za-z0-9+/]{43}=$/.test(value) &&
                    Buffer.from(value, "base64").length === 32 &&
                    Buffer.from(value, "base64").toString("base64") === value,
                "expected a canonical base64 32-byte public key"
            ),
        apns: z.object({ token: z.string().regex(/^[0-9a-f]{64,200}$/i) }).optional(),
        simulator: z.object({ udid: z.string().regex(/^[0-9A-F-]{36}$/i) }).optional(),
    })
    .refine((value) => Boolean(value.apns) !== Boolean(value.simulator), "name an APNs token or a simulator, not both");

/**
 * The phone side of push (F2): a phone registers on every start (its APNs token, or its simulator id, and its box key)
 * and gets the Mac's push key back, to open the sealed answer tokens. Keyed writes behind the full login.
 */
export function pushRoutes(
    deps: PushRouteDeps = { devices: filePhoneDeviceStore(), keys: () => loadPushKeys(), transports: PUSH_TRANSPORTS }
): RouteDef[] {
    return [
        bindEndpoint(ENDPOINTS.pushRegister, {
            input: registration,
            invalid: "expected { id, name, bundleId, publicKey, apns: { token } | simulator: { udid } }",
            run: async (input) => {
                const device = await registerPhoneDevice(deps.devices, input);
                const keys = await deps.keys();
                return { id: device.id, macPublicKey: keys.publicKey, route: device.route.kind };
            },
        }),
        bindEndpoint(ENDPOINTS.pushUnregister, {
            input: z.object({ id: z.string().min(1) }),
            invalid: "expected a device id",
            run: async (input) => ({ removed: await removePhoneDevice(deps.devices, input.id) }),
        }),
        bindEndpoint(ENDPOINTS.pushTest, {
            input: z.object({ id: z.string().min(1) }),
            invalid: "expected { id }",
            run: async (input): Promise<ChannelReceipt> => {
                // A channel over this one device, so the test reaches the phone that asked and no other.
                const one: PhoneDeviceStore = {
                    list: () => deps.devices.list().filter((device) => device.id === input.id),
                    update: (fn) => deps.devices.update(fn),
                };

                if (one.list().length === 0) {
                    return { ok: false, detail: "this phone is not registered" };
                }

                const { channels } = await notificationsConfig.load();
                const channel = createPhoneChannel({ devices: one, keys: deps.keys, transports: deps.transports });
                return channel.post(
                    {
                        app: "dev-dashboard",
                        title: "GenesisTools",
                        message: "Push to this phone works. The buttons answer nothing.",
                        id: `push-test-${input.id}`,
                        phone: {
                            answers: { letters: ["a", "b"], recommended: "a", tokens: { a: "test-a", b: "test-b" } },
                        },
                    },
                    { ...channels.phone, enabled: true, when: { desk: "always" } }
                );
            },
        }),
    ];
}
