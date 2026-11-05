import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";
import { notifyPhoneApnsCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isTestProcess } from "@genesiscz/utils/test-process";
import type { PhoneApnsConfig } from "../../types";
import type { ApnsEnvironment, PhoneRoute, PhoneRouteKind } from "./devices";

const log = logger.child({ component: "notifications:phone" });

/** One push to one device. */
export interface PushMessage {
    payload: Record<string, unknown>;
    /** `alert` shows; `background` wakes the app silently (a retraction). */
    pushType: "alert" | "background";
    /** Apple's rule: 10 for an alert, 5 for a background push. */
    priority: 5 | 10;
    /** The app's bundle id (APNs `apns-topic`). */
    topic: string;
    /** Replaces an earlier push with the same id on the device (APNs `apns-collapse-id`). */
    collapseId?: string;
}

export type PushResult =
    | { ok: true }
    /** `gone`: the device unregistered (the app was deleted); `otherEnvironment`: the token is for the other APNs host. */
    | { ok: false; reason: string; gone?: boolean; otherEnvironment?: boolean };

export interface PushTransport<R extends PhoneRoute> {
    send(route: R, message: PushMessage, apns: PhoneApnsConfig | undefined): Promise<PushResult>;
}

export type PushTransportTable = { readonly [K in PhoneRouteKind]: PushTransport<Extract<PhoneRoute, { kind: K }>> };

const APNS_HOSTS: Readonly<Record<ApnsEnvironment, string>> = {
    production: "https://api.push.apple.com",
    sandbox: "https://api.sandbox.push.apple.com",
};

const APNS_TIMEOUT_MS = 10_000;
/** Apple refuses a provider token older than an hour and throttles one renewed more often than every 20 minutes. */
const JWT_LIFETIME_MS = 50 * 60 * 1000;

let cachedJwt: { key: string; token: string; at: number } | undefined;

function base64url(value: string | Buffer): string {
    return Buffer.from(value).toString("base64url");
}

/** The ES256 provider token APNs takes in place of a certificate. */
export function apnsJwt(
    apns: Required<Pick<PhoneApnsConfig, "teamId" | "keyId">> & { key: string },
    now: number
): string {
    const header = base64url(SafeJSON.stringify({ alg: "ES256", kid: apns.keyId }));
    const claims = base64url(SafeJSON.stringify({ iss: apns.teamId, iat: Math.floor(now / 1000) }));
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
        key: createPrivateKey(apns.key),
        dsaEncoding: "ieee-p1363",
    });
    return `${header}.${claims}.${base64url(signature)}`;
}

function providerToken(apns: PhoneApnsConfig | undefined, now = Date.now()): string | { missing: string } {
    if (!apns?.teamId || !apns.keyId || !apns.keyPath) {
        return { missing: `the APNs team id, key id or key file is not set (${notifyPhoneApnsCommand()})` };
    }

    const cacheKey = `${apns.teamId}:${apns.keyId}:${apns.keyPath}`;

    if (cachedJwt?.key === cacheKey && now - cachedJwt.at < JWT_LIFETIME_MS) {
        return cachedJwt.token;
    }

    const token = apnsJwt({ teamId: apns.teamId, keyId: apns.keyId, key: readFileSync(apns.keyPath, "utf8") }, now);
    cachedJwt = { key: cacheKey, token, at: now };
    return token;
}

/** Sends over HTTP/2 to Apple, with token auth. */
export const apnsTransport: PushTransport<Extract<PhoneRoute, { kind: "apns" }>> = {
    async send(route, message, apns) {
        const jwt = providerToken(apns);

        if (typeof jwt !== "string") {
            return { ok: false, reason: jwt.missing };
        }

        const host = APNS_HOSTS[route.environment];
        log.debug({ host, pushType: message.pushType, topic: message.topic }, "APNs push");

        return new Promise<PushResult>((resolve) => {
            const client = connect(host);
            let settled = false;
            const done = (result: PushResult) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                client.destroy();
                resolve(result);
            };
            const timer = setTimeout(
                () => done({ ok: false, reason: `APNs did not answer in ${APNS_TIMEOUT_MS} ms` }),
                APNS_TIMEOUT_MS
            );

            client.on("error", (err) => {
                clearTimeout(timer);
                done({ ok: false, reason: err.message });
            });

            const request = client.request({
                ":method": "POST",
                ":path": `/3/device/${route.token}`,
                authorization: `bearer ${jwt}`,
                "apns-topic": message.topic,
                "apns-push-type": message.pushType,
                "apns-priority": String(message.priority),
                ...(message.collapseId ? { "apns-collapse-id": message.collapseId } : {}),
            });
            let status = 0;
            let body = "";
            request.on("response", (headers) => {
                status = Number(headers[":status"]);
            });
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.on("end", () => {
                clearTimeout(timer);

                if (status === 200) {
                    done({ ok: true });
                    return;
                }

                const reason = (SafeJSON.parse(body || "{}") as { reason?: string }).reason ?? `HTTP ${status}`;
                done({
                    ok: false,
                    reason,
                    ...(status === 410 || reason === "Unregistered" ? { gone: true } : {}),
                    ...(reason === "BadDeviceToken" ? { otherEnvironment: true } : {}),
                });
            });
            request.on("error", (err) => {
                clearTimeout(timer);
                done({ ok: false, reason: err.message });
            });
            request.end(SafeJSON.stringify(message.payload));
        });
    },
};

/** Delivers to a simulator with `xcrun simctl push`; no Apple account involved. */
export const simctlTransport: PushTransport<Extract<PhoneRoute, { kind: "simctl" }>> = {
    async send(route, message) {
        // The payload goes on stdin (`-`), so no file is left behind.
        const command = ["xcrun", "simctl", "push", route.udid, message.topic, "-"];
        log.debug({ command: command.join(" ") }, "simctl push");
        const proc = Bun.spawn(command, {
            stdin: new TextEncoder().encode(SafeJSON.stringify(message.payload)),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

        if (code !== 0) {
            const reason = stderr.trim() || `simctl push exited ${code}`;
            // A deleted simulator never comes back.
            return { ok: false, reason, ...(/Invalid device/i.test(reason) ? { gone: true } : {}) };
        }

        return { ok: true };
    },
};

/** In a test process every real transport refuses: a push to a real phone or simulator cannot be taken back. */
function guarded<R extends PhoneRoute>(transport: PushTransport<R>): PushTransport<R> {
    return {
        send: (route, message, apns) =>
            isTestProcess()
                ? Promise.resolve({ ok: false, reason: "real push transports are blocked in tests; pass a fake" })
                : transport.send(route, message, apns),
    };
}

export const PUSH_TRANSPORTS: PushTransportTable = {
    apns: guarded(apnsTransport),
    simctl: guarded(simctlTransport),
};
