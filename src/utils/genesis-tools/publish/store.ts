import { isAbsolute } from "node:path";
import { shareServerSetupCommand } from "@genesiscz/utils/genesis-tools/tools/publish";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { jsonDocument, prettyJson } from "@genesiscz/utils/storage/locked-document";
import { genesisToolsDirIn, toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import type { SyncRecord } from "../../publish/freshness";
import { isSnapshotId, KIND_ID_RE } from "../../publish/ids";
import { isHttpUrl, type PublishTarget, PublishTargetSchema, TARGET_NAME_RE } from "../../publish/targets";
import { PUBLISH_KIND_IDS, type PublishKindId } from "./kinds";

export interface ShareConfig {
    version: 2;
    defaults: { target?: string; server?: string };
    targets: PublishTarget[];
    servers: ShareServerConfig[];
    /** Per published kind (the axis is the kind: md syncs from a vault, an artifact does not). */
    kinds?: Partial<Record<string, ShareKindSettings>>;
}

export interface ShareKindSettings {
    /** A daemon task sends the publications edited since their last sync, this often. */
    autoSync?: { everyMinutes: number };
}

export interface ShareServerConfig {
    name: string;
    dataDir: string;
    stateDir: string;
    listen: { host: string; port: number };
    publicOrigin: string;
    kinds: PublishKindId[];
    minFreeGb: number;
    exposure: ServerExposure;
    service: ServerService;
}

export type ServerExposure =
    | { kind: "reverse-proxy"; proxy: "apache" | "nginx" | "caddy" | "other" }
    | { kind: "cloudflared"; tunnel: string }
    | { kind: "local" };

export type ServerService =
    | { manager: "systemd"; unit: string; user: string }
    | { manager: "launchd"; label: string }
    | { manager: "none" };

export type ExposureKind = ServerExposure["kind"];
export type ServiceManager = ServerService["manager"];

export interface Publication {
    kind: string;
    id: string;
    title: string;
    source: string;
    publishedAt: string;
    syncs: Record<string, SyncRecord>;
}

const NameSchema = z.string().regex(TARGET_NAME_RE);
const ServiceId = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/);
const AbsoluteDir = z.string().refine(isAbsolute, "expected an absolute folder path");

export const ShareServerConfigSchema: z.ZodType<ShareServerConfig> = z.object({
    name: NameSchema,
    dataDir: AbsoluteDir,
    stateDir: AbsoluteDir,
    listen: z.object({
        host: z.string().regex(/^[A-Za-z0-9_.:[\]-]+$/),
        port: z.number().int().min(1).max(65535),
    }),
    publicOrigin: z.string().refine((origin) => {
        if (!URL.canParse(origin)) {
            return false;
        }

        const url = new URL(origin);
        return isHttpUrl(url) && url.origin === origin;
    }, "expected an HTTP(S) origin"),
    kinds: z
        .array(z.enum(PUBLISH_KIND_IDS))
        .min(1)
        .refine((kinds) => new Set(kinds).size === kinds.length),
    minFreeGb: z
        .number()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER / 1024 ** 3),
    exposure: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("local") }),
        z.object({ kind: z.literal("reverse-proxy"), proxy: z.enum(["apache", "nginx", "caddy", "other"]) }),
        z.object({ kind: z.literal("cloudflared"), tunnel: z.string().regex(/^[a-zA-Z0-9_-]+$/) }),
    ]),
    service: z.discriminatedUnion("manager", [
        z.object({ manager: z.literal("none") }),
        z.object({
            manager: z.literal("systemd"),
            unit: ServiceId,
            user: ServiceId.refine((user) => user !== "root" && user !== "0"),
        }),
        z.object({ manager: z.literal("launchd"), label: ServiceId }),
    ]),
});

function uniqueNames(values: ReadonlyArray<{ name: string }>): boolean {
    return new Set(values.map(({ name }) => name)).size === values.length;
}

export const ShareConfigSchema: z.ZodType<ShareConfig> = z.object({
    version: z.literal(2),
    defaults: z.object({ target: NameSchema.optional(), server: NameSchema.optional() }),
    targets: z.array(PublishTargetSchema).refine(uniqueNames, "each target needs a unique name"),
    servers: z.array(ShareServerConfigSchema).refine(uniqueNames, "each server needs a unique name"),
    kinds: z
        .record(
            z.string().regex(KIND_ID_RE),
            z.object({ autoSync: z.object({ everyMinutes: z.number().int().min(1).max(1440) }).optional() })
        )
        .optional(),
});

export const PublicationSchema: z.ZodType<Publication> = z.object({
    kind: z.string().regex(KIND_ID_RE),
    id: z.string().refine(isSnapshotId),
    title: z.string(),
    source: z.string(),
    publishedAt: z.string(),
    syncs: z.record(
        z.string().regex(TARGET_NAME_RE),
        z.object({
            syncedAt: z.string(),
            sourceModifiedAt: z.string(),
        })
    ),
});

const PublicationsSchema = z.object({ version: z.literal(1), publications: z.array(PublicationSchema) });
type Publications = z.infer<typeof PublicationsSchema>;

function emptyConfig(): ShareConfig {
    return { version: 2, defaults: {}, targets: [], servers: [] };
}

const PreviousConfig = z.object({
    version: z.literal(1),
    client: z.object({
        defaults: z.object({ target: NameSchema.optional() }),
        targets: z.array(PublishTargetSchema),
    }),
});

export function migrateShareConfig(raw: unknown): unknown {
    if (raw == null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0)) {
        return emptyConfig();
    }

    const previous = PreviousConfig.safeParse(raw);
    return previous.success ? { version: 2, ...previous.data.client, servers: [] } : raw;
}

export function shareConfigPath(): string {
    return toolDataDir("share", "config.json");
}

export function publicationsPath(): string {
    return toolDataDir("share", "publications.json");
}

export function shareServerDir(name: string, part: "data" | "state"): string {
    return toolDataDir("share", "servers", NameSchema.parse(name), part);
}

function configDocument(path: string, empty = emptyConfig, writes?: "always") {
    return jsonDocument({
        path,
        empty,
        writes,
        decode: (raw) => ShareConfigSchema.parse(migrateShareConfig(raw)),
        encode: prettyJson,
        strictJson: true,
        onUnreadable: "refuse",
        fileMode: 0o600,
        dirMode: 0o700,
    });
}

async function configForHome(home?: string) {
    const path = home ? genesisToolsDirIn(home, "share", "config.json") : shareConfigPath();
    if (await Bun.file(path).exists()) {
        return configDocument(path);
    }

    const previous = home ? genesisToolsDirIn(home, "publish", "config.json") : toolDataDir("publish", "config.json");
    const fallback = await configDocument(previous).readAsync();
    return configDocument(path, () => fallback, "always");
}

export async function loadShareConfig(): Promise<ShareConfig> {
    return loadShareConfigForHome();
}

export async function loadShareConfigForHome(home?: string): Promise<ShareConfig> {
    return (await configForHome(home)).readAsync();
}

export function updateShareConfig(change: (config: ShareConfig) => ShareConfig): Promise<ShareConfig> {
    return updateShareConfigForHome({ change });
}

export async function updateShareConfigForHome(input: {
    home?: string;
    change: (config: ShareConfig) => ShareConfig;
}): Promise<ShareConfig> {
    const document = await configForHome(input.home);
    return document.update((current) => {
        const next = ShareConfigSchema.parse(input.change(current));
        return { write: next, result: next };
    });
}

export function resolveServer(config: ShareConfig, name?: string): ShareServerConfig {
    const wanted = name ?? config.defaults.server;
    const server = wanted
        ? config.servers.find((entry) => entry.name === wanted)
        : config.servers.length === 1
          ? config.servers[0]
          : undefined;
    if (server) {
        return server;
    }

    if (wanted) {
        throw new Error(`Unknown share server "${wanted}"`);
    }

    if (config.servers.length) {
        throw new Error(`Choose a share server with --server: ${config.servers.map(({ name }) => name).join(", ")}`);
    }

    throw new Error(`Set up a share server with ${shareServerSetupCommand("server")}`);
}

function emptyPublications(): Publications {
    return { version: 1, publications: [] };
}

function publicationDocument(path: string, empty = emptyPublications, writes?: "always") {
    return jsonDocument({
        path,
        empty,
        writes,
        decode: (raw) => PublicationsSchema.parse(raw),
        encode: prettyJson,
        strictJson: true,
        onUnreadable: "refuse",
        fileMode: 0o600,
        dirMode: 0o700,
    });
}

async function publicationsDocument() {
    const path = publicationsPath();
    if (await Bun.file(path).exists()) {
        return publicationDocument(path);
    }

    const previous = toolDataDir("publish", "publications.json");
    const fallback = await publicationDocument(previous).readAsync();
    return publicationDocument(path, () => fallback, "always");
}

export async function listPublications(kind?: string): Promise<Publication[]> {
    const { publications } = await (await publicationsDocument()).readAsync();
    return kind === undefined ? publications : publications.filter((entry) => entry.kind === kind);
}

export async function findPublication(input: {
    kind: string;
    id?: string;
    source?: string;
}): Promise<Publication | undefined> {
    if (input.id === undefined && input.source === undefined) {
        return undefined;
    }

    return (await listPublications(input.kind)).find(
        (entry) =>
            (input.id === undefined || entry.id === input.id) &&
            (input.source === undefined || entry.source === input.source)
    );
}

export async function savePublication(entry: Publication): Promise<void> {
    const saved = PublicationSchema.parse(entry);
    await (await publicationsDocument()).mutate((doc) => {
        const index = doc.publications.findIndex(({ kind, id }) => kind === saved.kind && id === saved.id);
        if (index >= 0) {
            doc.publications[index] = saved;
        } else {
            doc.publications.push(saved);
        }
    });
}

export async function forgetPublication(input: { kind: string; id: string }): Promise<void> {
    await (await publicationsDocument()).mutate((doc) => {
        doc.publications = doc.publications.filter(({ kind, id }) => kind !== input.kind || id !== input.id);
    });
}

/** Serializes a kind's network sends, removals and ledger updates across CLI and dashboard processes. */
export function withPublicationLock<T>(kind: string, run: () => Promise<T>): Promise<T> {
    if (!KIND_ID_RE.test(kind)) {
        throw new Error(`Invalid published kind: ${kind}`);
    }

    return withFileLock(toolDataDir("share", `.${kind}.lock`), run, 300_000);
}
