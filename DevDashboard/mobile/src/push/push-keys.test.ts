import { expect, it, mock } from "bun:test";
import nacl from "tweetnacl";
import util from "tweetnacl-util";
let stored: string | null = null;
mock.module("expo-secure-store", () => ({
    AFTER_FIRST_UNLOCK: "after-first-unlock",
    getItemAsync: async () => stored,
    setItemAsync: async (_key: string, value: string) => { stored = value; },
}));
const { pushIdentity, rememberMacKey, openSealed } = await import("./push-keys");
it("retains both Macs' keys and authenticates the originating connection, including concurrent registration", async () => {
    const phone = await pushIdentity();
    const a = nacl.box.keyPair();
    const b = nacl.box.keyPair();
    await Promise.all([rememberMacKey(util.encodeBase64(a.publicKey), "mac-a"), rememberMacKey(util.encodeBase64(b.publicKey), "mac-b")]);
    for (const [connectionId, mac] of [["mac-a", a], ["mac-b", b]] as const) {
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const box = nacl.box(util.decodeUTF8(JSON.stringify({ tokens: { a: "fixture-token" } })), nonce,
            util.decodeBase64(phone.publicKey), mac.secretKey);
        const opened = await openSealed({ box: util.encodeBase64(box), nonce: util.encodeBase64(nonce) });
        expect(opened?.connectionId).toBe(connectionId);
        expect(opened?.tokens.a).toBe("fixture-token");
    }
});

const registrations: string[] = [];
const registrationMac = nacl.box.keyPair();
const macClient = (id: string) => ({ call: async () => {
    registrations.push(id);
    return { macPublicKey: util.encodeBase64(registrationMac.publicKey) };
} });
let connection = { activeId: "register-a", transport: { client: () => macClient("a") } };
mock.module("@/state/connection-store", () => ({ useConnectionStore: { getState: () => connection } }));
mock.module("@/features/connections/store", () => ({
    getConnection: async () => null, buildTransportFor: async () => ({ client: () => macClient("unused") }),
}));
mock.module("expo-application", () => ({ applicationId: "app.fixture.mobile" }));
mock.module("expo-device", () => ({ isDevice: true, deviceName: "fixture phone" }));
mock.module("expo-sqlite", () => ({ defaultDatabaseDirectory: "" }));
mock.module("expo-task-manager", () => ({ defineTask: () => {} }));
mock.module("expo-notifications", () => ({
    requestPermissionsAsync: async () => {
        connection = { activeId: "register-b", transport: { client: () => macClient("b") } };
        return { granted: true };
    },
    getDevicePushTokenAsync: async () => ({ data: "fixture-device-token" }),
}));
const { registerForPush } = await import("./push");
it("keeps registration on its captured Mac when the active connection changes during permission", async () => {
    expect(await registerForPush()).toBeNull();
    expect(registrations).toEqual(["a"]);
    expect((await pushIdentity()).macPublicKeys?.["register-a"]).toBe(util.encodeBase64(registrationMac.publicKey));
});
