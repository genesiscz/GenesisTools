import { SafeJSON } from "@app/utils/json";
import type {
    DeviceCodeResponse,
    DeviceFlowCallbacks,
    DeviceFlowConfig,
    DeviceTokenError,
    DeviceTokenSuccess,
} from "@app/utils/oauth/types";

const INITIAL_POLL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_MULTIPLIER = 1.4;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Login cancelled"));
            return;
        }

        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new Error("Login cancelled"));
            },
            { once: true }
        );
    });
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, init);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }

    return response.json();
}

async function fetchDeviceTokenResponse(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, init);
    const text = await response.text();

    let data: unknown;
    try {
        data = text ? SafeJSON.parse(text, { strict: true }) : null;
    } catch (err) {
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}: ${text}`);
        }

        throw new Error("Invalid device token response", { cause: err });
    }

    // RFC 8628: authorization_pending and slow_down are returned as HTTP 400.
    if (
        !response.ok &&
        response.status === 400 &&
        data &&
        typeof data === "object" &&
        typeof (data as DeviceTokenError).error === "string"
    ) {
        return data;
    }

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }

    return data;
}

export async function startDeviceFlow(config: DeviceFlowConfig): Promise<DeviceCodeResponse> {
    const data = await fetchJson(config.deviceCodeUrl, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            ...(config.userAgent ? { "User-Agent": config.userAgent } : {}),
        },
        body: new URLSearchParams({
            client_id: config.clientId,
            scope: config.scope,
        }),
    });

    if (!data || typeof data !== "object") {
        throw new Error("Invalid device code response");
    }

    const record = data as Record<string, unknown>;
    const device_code = record.device_code;
    const user_code = record.user_code;
    const verification_uri = record.verification_uri;
    const interval = record.interval;
    const expires_in = record.expires_in;

    if (
        typeof device_code !== "string" ||
        typeof user_code !== "string" ||
        typeof verification_uri !== "string" ||
        typeof interval !== "number" ||
        typeof expires_in !== "number"
    ) {
        throw new Error("Invalid device code response fields");
    }

    return {
        device_code,
        user_code,
        verification_uri,
        interval,
        expires_in,
    };
}

export async function pollDeviceToken(args: {
    config: DeviceFlowConfig;
    deviceCode: string;
    intervalSeconds: number;
    expiresIn: number;
    callbacks?: DeviceFlowCallbacks;
    signal?: AbortSignal;
}): Promise<string> {
    const { config, deviceCode, intervalSeconds, expiresIn, signal } = args;
    const deadline = Date.now() + expiresIn * 1000;
    let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
    let intervalMultiplier = INITIAL_POLL_MULTIPLIER;

    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new Error("Login cancelled");
        }

        const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), deadline - Date.now());
        await sleep(waitMs, signal);

        const raw = await fetchDeviceTokenResponse(config.tokenUrl, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                ...(config.userAgent ? { "User-Agent": config.userAgent } : {}),
            },
            body: new URLSearchParams({
                client_id: config.clientId,
                device_code: deviceCode,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
        });

        if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccess).access_token === "string") {
            return (raw as DeviceTokenSuccess).access_token;
        }

        if (raw && typeof raw === "object" && typeof (raw as DeviceTokenError).error === "string") {
            const err = raw as DeviceTokenError;

            if (err.error === "authorization_pending") {
                continue;
            }

            if (err.error === "slow_down") {
                intervalMs =
                    typeof err.interval === "number" && err.interval > 0
                        ? err.interval * 1000
                        : Math.max(1000, intervalMs + 5000);
                intervalMultiplier = SLOW_DOWN_POLL_MULTIPLIER;
                continue;
            }

            const suffix = err.error_description ? `: ${err.error_description}` : "";
            throw new Error(`Device flow failed: ${err.error}${suffix}`);
        }
    }

    throw new Error("Device flow timed out");
}

export async function runGitHubDeviceLogin(callbacks: DeviceFlowCallbacks, signal?: AbortSignal): Promise<string> {
    const { GITHUB_COPILOT_OAUTH } = await import("@app/utils/oauth/github-device");
    const config: DeviceFlowConfig = {
        clientId: GITHUB_COPILOT_OAUTH.clientId,
        scope: GITHUB_COPILOT_OAUTH.scope,
        deviceCodeUrl: GITHUB_COPILOT_OAUTH.deviceCodeUrl,
        tokenUrl: GITHUB_COPILOT_OAUTH.tokenUrl,
        userAgent: GITHUB_COPILOT_OAUTH.userAgent,
    };

    const device = await startDeviceFlow(config);
    callbacks.onUserCode({
        userCode: device.user_code,
        verificationUri: device.verification_uri,
    });

    return pollDeviceToken({
        config,
        deviceCode: device.device_code,
        intervalSeconds: device.interval,
        expiresIn: device.expires_in,
        callbacks,
        signal,
    });
}
