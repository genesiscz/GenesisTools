import { SafeJSON } from "@app/utils/json";
import type { AIEmbeddingProvider, AIProvider, AITask, EmbedOptions, EmbeddingResult } from "../types";

const SUPPORTED_TASKS: AITask[] = ["embed"];

/** Google batchEmbedContents supports up to 100 texts per request. */
const GOOGLE_BATCH_SIZE = 100;

/** Max input tokens for gemini-embedding-001. */
const GOOGLE_MAX_TOKENS = 2048;

/** Conservative chars-per-token estimate for code (SentencePiece tokenizer). */
const CHARS_PER_TOKEN_ESTIMATE = 3.0;

/** Minimum delay between batch API calls (ms). Free tier: 5 RPM = 12s between calls. */
const GOOGLE_RATE_LIMIT_DELAY_MS = 12_000;

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GoogleBatchEmbedRequest {
    requests: Array<{
        model: string;
        content: { parts: Array<{ text: string }> };
    }>;
}

interface GoogleBatchEmbedResponse {
    embeddings: Array<{ values: number[] }>;
}

export interface AIGoogleProviderOptions {
    /** Embedding model name. Default: gemini-embedding-001 */
    model?: string;
    /** Override max context length in tokens. Default: 2048 */
    maxTokens?: number;
    /** Override rate limit delay between batch calls (ms). Default: 12000 (free tier: 5 RPM). */
    rateLimitMs?: number;
}

export class AIGoogleProvider implements AIProvider, AIEmbeddingProvider {
    readonly type = "google" as const;
    readonly dimensions = 3072;
    private model: string;
    private maxChars: number;
    private rateLimitDelayMs: number;

    constructor(options?: AIGoogleProviderOptions) {
        this.model = options?.model ?? "gemini-embedding-001";
        this.maxChars = Math.floor((options?.maxTokens ?? GOOGLE_MAX_TOKENS) * CHARS_PER_TOKEN_ESTIMATE);
        this.rateLimitDelayMs = options?.rateLimitMs ?? GOOGLE_RATE_LIMIT_DELAY_MS;
    }

    async isAvailable(): Promise<boolean> {
        return !!process.env.GOOGLE_API_KEY;
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const results = await this.embedBatch([text], options);

        if (!results[0]) {
            throw new Error("Google embedding API returned empty result");
        }

        return results[0];
    }

    async embedBatch(texts: string[], _options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const apiKey = process.env.GOOGLE_API_KEY;

        if (!apiKey) {
            throw new Error(
                "GOOGLE_API_KEY environment variable is required. " +
                "Get a free key at https://aistudio.google.com/apikey"
            );
        }

        const truncated = this.pretruncate(texts);
        const results: EmbeddingResult[] = [];

        for (let i = 0; i < truncated.length; i += GOOGLE_BATCH_SIZE) {
            const batch = truncated.slice(i, i + GOOGLE_BATCH_SIZE);

            if (i > 0) {
                await this.rateLimitWait();
            }

            const embeddings = await this.fetchBatch(batch, apiKey);
            results.push(...embeddings);
        }

        return results;
    }

    private lastCallTime = 0;

    private async rateLimitWait(): Promise<void> {
        const elapsed = Date.now() - this.lastCallTime;
        const remaining = this.rateLimitDelayMs - elapsed;

        if (remaining > 0 && this.lastCallTime > 0) {
            await new Promise((resolve) => setTimeout(resolve, remaining));
        }

        this.lastCallTime = Date.now();
    }

    private pretruncate(texts: string[]): string[] {
        return texts.map((t) =>
            t.length > this.maxChars ? t.substring(0, this.maxChars) : t
        );
    }

    private async fetchBatch(texts: string[], apiKey: string): Promise<EmbeddingResult[]> {
        const modelPath = `models/${this.model}`;
        const url = `${GOOGLE_API_BASE}/${modelPath}:batchEmbedContents?key=${apiKey}`;

        const body: GoogleBatchEmbedRequest = {
            requests: texts.map((text) => ({
                model: modelPath,
                content: { parts: [{ text }] },
            })),
        };

        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify(body),
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            throw new Error(
                `Google batchEmbedContents failed: ${resp.status} ${resp.statusText} — ${errorText}`
            );
        }

        const data = (await resp.json()) as GoogleBatchEmbedResponse;

        return data.embeddings.map((e) => {
            const vector = new Float32Array(e.values);
            return { vector, dimensions: vector.length };
        });
    }

    dispose(): void {
        // Stateless HTTP client — nothing to clean up
    }
}
