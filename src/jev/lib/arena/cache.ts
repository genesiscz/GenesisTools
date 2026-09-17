import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { CIRCUIT_REVISION, CIRCUIT_TIERS, type CircuitStatus, type CircuitTier, parseCircuit } from "./circuit";

export function circuitBlobHash(bytes: Uint8Array): string {
    return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function downloadCircuit({ url, signal, maxBytes }: { url: string; signal: AbortSignal; maxBytes: number }) {
    const response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok || !response.body) {
        throw new Error(`Circuit download failed (HTTP ${response.status}). Retry when connected.`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            length += value.length;
            if (length > maxBytes) {
                await reader.cancel();
                throw new Error("Circuit download exceeds its pinned size.");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }

    return bytes;
}

export class CircuitCache {
    private readonly directory: string;
    private readonly tiers: readonly CircuitTier[];
    private readonly download: typeof downloadCircuit;
    private readonly pending = new Map<
        string,
        Promise<{ graph: ReturnType<typeof parseCircuit>; cacheHit: boolean }>
    >();

    constructor(
        options: { directory?: string; tiers?: readonly CircuitTier[]; download?: typeof downloadCircuit } = {}
    ) {
        this.directory = options.directory ?? join(new Storage("jev").getCacheDir(), "male-cns", CIRCUIT_REVISION);
        this.tiers = options.tiers ?? CIRCUIT_TIERS;
        this.download = options.download ?? downloadCircuit;
    }

    async status(): Promise<CircuitStatus[]> {
        return Promise.all(
            this.tiers.map(async (tier) => {
                try {
                    const file = await stat(join(this.directory, tier.file));
                    return { ...tier, cached: file.size === tier.bytes };
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }

                    return { ...tier, cached: false };
                }
            })
        );
    }

    async load({ tierId, signal }: { tierId: string; signal?: AbortSignal }) {
        signal?.throwIfAborted();
        const tier = this.tiers.find((entry) => entry.id === tierId);
        if (!tier) {
            throw new Error("Unknown MaleCNS circuit tier.");
        }
        const existing = this.pending.get(tier.id);
        if (existing) {
            return existing;
        }
        const operation = this.loadTier({ tier, signal });
        this.pending.set(tier.id, operation);
        try {
            return await operation;
        } finally {
            this.pending.delete(tier.id);
        }
    }

    private async loadTier({ tier, signal }: { tier: CircuitTier; signal?: AbortSignal }) {
        const file = join(this.directory, tier.file);
        const validate = (bytes: Uint8Array) => {
            if (bytes.length !== tier.bytes || circuitBlobHash(bytes) !== tier.blob) {
                throw new Error("MaleCNS circuit checksum mismatch.");
            }

            return parseCircuit(SafeJSON.parse(new TextDecoder().decode(bytes), { strict: true }), tier);
        };
        try {
            const bytes = await readFile(file);
            const graph = validate(bytes);
            logger.debug({ tier: tier.id, file }, "Using verified MaleCNS cache");
            return { graph, cacheHit: true };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                logger.warn({ error, tier: tier.id }, "MaleCNS cache unreadable or invalid; downloading replacement");
            }
        }
        const url = `https://raw.githubusercontent.com/hrook1/Swat/${CIRCUIT_REVISION}/public/data/${tier.file}`;
        logger.info({ tier: tier.id, url, bytes: tier.bytes }, "Downloading MaleCNS circuit on demand");
        const deadline = AbortSignal.timeout(120000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const bytes = await this.download({ url, signal: combined, maxBytes: tier.bytes });
        combined.throwIfAborted();
        const graph = validate(bytes);
        await mkdir(this.directory, { recursive: true });
        const partial = `${file}.${randomUUID()}.partial`;
        try {
            await Bun.write(partial, bytes);
            combined.throwIfAborted();
            await rename(partial, file);
        } finally {
            await rm(partial, { force: true });
        }

        logger.info(
            { tier: tier.id, neurons: graph.neurons.length, edges: graph.edges.length, file },
            "MaleCNS circuit cached"
        );
        return { graph, cacheHit: false };
    }
}

export const circuitCache = new CircuitCache();
