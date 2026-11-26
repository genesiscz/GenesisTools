import { hostname } from "node:os";
import { redeemPairingCode } from "@genesiscz/utils/device-pairing/client";
import { PairRequestSchema } from "@genesiscz/utils/device-pairing/types";
import { shareServerPairCommand, shareServerSetupCommand } from "@genesiscz/utils/genesis-tools/tools/publish";
import { logger } from "@genesiscz/utils/logger";
import { resolveSecret, type SecretStore, type SecureRef, secrets } from "@genesiscz/utils/security";
import {
    HealthSchema,
    PUBLISH_API,
    PUBLISH_SERVER_HEADER,
    PUBLISH_SERVER_ID,
    SnapshotListSchema,
    WhoamiSchema,
} from "../api";
import { KIND_ID_RE, originOf } from "../ids";
import { packSnapshot } from "../snapshot-store";
import { isPrivateOrHttps, PublishTargetSchema, TARGET_NAME_RE, type TargetWith } from "../targets";
import { type PublishTransport, setupValue, type TransportCheck, targetWith, validateUrl } from "./types";

const { log } = logger.scoped("publish-paired");

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;

export interface PairedTransportDeps {
    secrets: () => Promise<Pick<SecretStore, "set" | "delete">>;
    resolveToken: (ref: SecureRef) => Promise<string | undefined>;
    fetch: typeof fetch;
}

const liveDeps: PairedTransportDeps = { secrets, resolveToken: resolveSecret, fetch };

export function tokenPath(targetName: string): string {
    return `publish/targets/${targetName}/token`;
}

async function requireOk(res: Response, operation: string): Promise<void> {
    if (res.ok) {
        return;
    }

    await res.body?.cancel();
    throw new Error(`${operation}: HTTP ${res.status}`);
}

function validatePairingUrl(value: string): string | undefined {
    const problem = validateUrl(value);
    if (problem) {
        return problem;
    }

    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "").slice(1);
    if (url.search || url.hash || (path && !KIND_ID_RE.test(path))) {
        return "an origin or an origin followed by a published kind";
    }

    return isPrivateOrHttps(url) ? undefined : "HTTP requires a private host";
}

async function checkRow(label: string, check: () => Promise<string>): Promise<TransportCheck> {
    try {
        return { label, ok: true, detail: await check() };
    } catch (err) {
        return { label, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}

export function createPairedTransport(
    deps: PairedTransportDeps = liveDeps
): PublishTransport & { readonly kind: "paired" } {
    const authorized = async (target: TargetWith<"paired">): Promise<string> => {
        const token = await deps.resolveToken(target.transport.token);
        if (!token) {
            throw new Error(`publish target "${target.name}" has no token in the vault; pair it again`);
        }

        return token;
    };

    const request = (url: string, path: string, init?: RequestInit) =>
        deps.fetch(new URL(path, url), {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ...init,
            redirect: "error",
        });
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    const whoami = async (url: string, token: string, deviceId: string): Promise<string> => {
        const res = await request(url, PUBLISH_API.whoami, { headers: bearer(token) });
        await requireOk(res, "checking paired device");
        const device = WhoamiSchema.parse(await res.json());
        if (device.deviceId !== deviceId) {
            throw new Error("The token belongs to a different device on the server");
        }

        return device.name;
    };

    return {
        kind: "paired",
        summary: "upload each snapshot to a publish server paired with a one-time code",
        live: false,
        pageUrl: ({ target, kind, id }) => `${target.publicBase}/${kind}/${encodeURIComponent(id)}`,
        send: async ({ target, kind, id, dir }) => {
            const paired = targetWith(target, "paired");
            const headers = bearer(await authorized(paired));
            const body = await packSnapshot(dir);
            const res = await request(paired.transport.url, PUBLISH_API.snapshot(kind, id), {
                method: "PUT",
                headers: { ...headers, "Content-Type": "application/zip" },
                body: new Uint8Array(body),
                signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
            });
            await requireOk(res, `uploading ${id} to ${target.name}`);
            await res.body?.cancel();
            log.info({ target: target.name, kind, id }, "snapshot uploaded");
        },
        remove: async ({ target, kind, id }) => {
            const paired = targetWith(target, "paired");
            const res = await request(paired.transport.url, PUBLISH_API.snapshot(kind, id), {
                method: "DELETE",
                headers: bearer(await authorized(paired)),
            });
            if (res.status !== 404) {
                await requireOk(res, `removing ${id} from ${target.name}`);
            }

            await res.body?.cancel();
        },
        list: async ({ target, kind }) => {
            const paired = targetWith(target, "paired");
            const res = await request(paired.transport.url, PUBLISH_API.snapshots(kind), {
                headers: bearer(await authorized(paired)),
            });
            await requireOk(res, `listing snapshots on ${target.name}`);
            return SnapshotListSchema.parse(await res.json()).ids;
        },
        check: async (target) => {
            const paired = targetWith(target, "paired");
            const { url, deviceId } = paired.transport;

            const health = await checkRow("Server health", async () => {
                const res = await request(url, PUBLISH_API.health);
                await requireOk(res, "checking publish server health");
                const health = HealthSchema.parse(await res.json());
                if (res.headers.get(PUBLISH_SERVER_HEADER) !== PUBLISH_SERVER_ID) {
                    throw new Error("Publish server header missing");
                }

                return `${url} serves ${health.kinds.join(", ")}`;
            });
            const device = await checkRow("Paired device", async () => {
                const name = await whoami(url, await authorized(paired), deviceId);
                return `${name} (${deviceId})`;
            });

            return [health, device];
        },
        setup: async (input) => {
            if (!TARGET_NAME_RE.test(input.name)) {
                throw new Error(`Invalid publish target name: ${input.name}`);
            }

            const url = originOf(
                await setupValue(input, {
                    flag: "url",
                    message: "Publish server origin (e.g. https://share.example.com)",
                    validate: validatePairingUrl,
                })
            );
            const base = input.values["public-base"]?.trim() || url;
            const publicBaseProblem = validateUrl(base);
            if (publicBaseProblem) {
                throw new Error(`--public-base: ${publicBaseProblem}`);
            }

            const publicBase = originOf(base);
            const code = await setupValue(input, {
                flag: "code",
                message: `Pairing code (run ${shareServerPairCommand()} on the server)`,
            });
            const deviceName = input.values["device-name"]?.trim() || hostname();
            const pairing = PairRequestSchema.parse({ code, deviceName });
            const paired = await redeemPairingCode({
                url,
                ...pairing,
                fetch: Object.assign(
                    async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                        const res = await deps.fetch(request, init);
                        if (res.status === 404 && res.headers.get(PUBLISH_SERVER_HEADER) === PUBLISH_SERVER_ID) {
                            await res.body?.cancel();
                            throw new Error(
                                `Update the publish server by running ${shareServerSetupCommand("server")} there`
                            );
                        }

                        return res;
                    },
                    { preconnect: deps.fetch.preconnect }
                ),
            });
            await whoami(url, paired.token, paired.deviceId);
            const token = await (await deps.secrets()).set(tokenPath(input.name), paired.token);

            return PublishTargetSchema.parse({
                name: input.name,
                publicBase,
                transport: { kind: "paired", url, deviceId: paired.deviceId, token },
            });
        },
        forget: async (target) => {
            await (await deps.secrets()).delete(targetWith(target, "paired").transport.token.path);
        },
    };
}

export const pairedTransport = createPairedTransport();
