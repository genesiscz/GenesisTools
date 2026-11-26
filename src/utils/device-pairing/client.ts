import { SafeJSON } from "@genesiscz/utils/json";
import { PairResponseSchema } from "./types";

const PAIR_TIMEOUT_MS = 30_000;

export class PairingRefusedError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "PairingRefusedError";
    }
}

export async function redeemPairingCode(input: {
    url: string;
    code: string;
    deviceName: string;
    fetch?: typeof fetch;
}): Promise<{ deviceId: string; token: string }> {
    const res = await (input.fetch ?? fetch)(new URL("/_api/pair", input.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ code: input.code, deviceName: input.deviceName }),
        signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
        redirect: "error",
    });

    if (!res.ok) {
        throw new PairingRefusedError(res.status, `Pairing failed: HTTP ${res.status}`);
    }

    return PairResponseSchema.parse(await res.json());
}

export function bearerToken(req: Request): string | null {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer (\S+)$/.exec(header);

    return match?.[1] ?? null;
}
