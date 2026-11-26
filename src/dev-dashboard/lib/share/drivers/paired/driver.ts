import { hostname } from "node:os";
import { PairedTargetSchema } from "@app/dev-dashboard/lib/share/drivers/paired/options";
import {
    pageUrlUnder,
    type ShareDriver,
    setupValue,
    targetOf,
    validateUrl,
} from "@app/dev-dashboard/lib/share/drivers/types";
import { PairResponseSchema, SHARE_API, SnapshotListSchema } from "@app/dev-dashboard/lib/share/server/api";
import { snapshotEntries, withShareSnapshot } from "@app/dev-dashboard/lib/share/snapshot";
import { vaultShareSource } from "@app/dev-dashboard/lib/share/vault-source";
import { zipAsync } from "@genesiscz/utils/fs/zip";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { resolveSecret, type SecretStore, type SecureRef, secrets } from "@genesiscz/utils/security";

const { log } = logger.scoped("share-paired");

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;

export interface PairedDriverDeps {
    secrets: () => Promise<Pick<SecretStore, "set" | "delete">>;
    resolveToken: (ref: SecureRef) => Promise<string | undefined>;
    fetch: typeof fetch;
}

const LIVE_DEPS: PairedDriverDeps = { secrets, resolveToken: resolveSecret, fetch };

export function tokenPath(targetName: string): string {
    return `dev-dashboard/share-targets/${targetName}/token`;
}

async function failure(res: Response, what: string): Promise<Error> {
    const text = await res.text().catch(() => "");

    return new Error(`${what} failed: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
}

/** A share server this Mac paired with: `share target add <name> --driver paired --url <url> --code <code>`. */
export function createPairedDriver(deps: PairedDriverDeps = LIVE_DEPS): ShareDriver {
    const authorized = async (target: ReturnType<typeof targetOf<"paired">>): Promise<Record<string, string>> => {
        const token = await deps.resolveToken(target.token);

        if (!token) {
            throw new Error(`share target "${target.name}" has no upload token in the vault; pair it again`);
        }

        return { Authorization: `Bearer ${token}` };
    };

    return {
        kind: "paired",
        summary: "upload each snapshot over HTTPS to a share server this Mac paired with (a one-time code)",
        live: false,
        pageUrl: async (target, slug) => {
            const paired = targetOf(target, "paired");

            return pageUrlUnder(paired.publicBase ?? paired.url, slug);
        },
        sync: async (target, note) => {
            const paired = targetOf(target, "paired");
            const headers = await authorized(paired);

            await withShareSnapshot({
                source: vaultShareSource(),
                note,
                fn: async (dir) => {
                    const body = await zipAsync(await snapshotEntries(dir));
                    const res = await deps.fetch(`${paired.url}${SHARE_API.snapshot(note.slug)}`, {
                        method: "PUT",
                        headers: { ...headers, "Content-Type": "application/zip" },
                        // An ArrayBuffer-backed copy: a Uint8Array<ArrayBufferLike> is not a BodyInit.
                        body: new Uint8Array(body),
                        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
                    });

                    if (!res.ok) {
                        throw await failure(res, `upload of ${note.slug} to ${paired.name}`);
                    }
                },
            });
            log.info({ target: paired.name, slug: note.slug }, "share snapshot uploaded");
        },
        remove: async (target, slug) => {
            const paired = targetOf(target, "paired");
            const res = await deps.fetch(`${paired.url}${SHARE_API.snapshot(slug)}`, {
                method: "DELETE",
                headers: await authorized(paired),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            if (!res.ok && res.status !== 404) {
                throw await failure(res, `removal of ${slug} from ${paired.name}`);
            }
        },
        listSlugs: async (target) => {
            const paired = targetOf(target, "paired");
            const res = await deps.fetch(`${paired.url}${SHARE_API.snapshots}`, {
                headers: await authorized(paired),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            if (!res.ok) {
                throw await failure(res, `listing ${paired.name}`);
            }

            return SnapshotListSchema.parse(await res.json()).slugs;
        },
        setup: async (input) => {
            const url = (
                await setupValue(input, {
                    flag: "url",
                    message: "Share server URL (its share base, e.g. https://example.com/share)",
                    validate: validateUrl,
                })
            ).replace(/\/+$/, "");
            const code = await setupValue(input, {
                flag: "code",
                message: "Pairing code (run `tools dev-dashboard share-server pair` on the server)",
            });
            const deviceName = input.values["device-name"]?.trim() || hostname();
            const res = await deps.fetch(`${url}${SHARE_API.pair}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ code, deviceName }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            if (!res.ok) {
                throw await failure(res, "pairing");
            }

            const paired = PairResponseSchema.parse(await res.json());
            const token = await (await deps.secrets()).set(tokenPath(input.name), paired.token);

            return PairedTargetSchema.parse({
                name: input.name,
                driver: "paired",
                url,
                deviceId: paired.deviceId,
                token,
                publicBase: input.values["public-base"]?.trim() || url,
            });
        },
        forget: async (target) => {
            await (await deps.secrets()).delete(targetOf(target, "paired").token.path);
        },
    };
}

export const pairedDriver: ShareDriver = createPairedDriver();
