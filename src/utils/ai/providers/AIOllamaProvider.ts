import { SafeJSON } from "@app/utils/json";
import type {
    AIEmbeddingProvider,
    AIProvider,
    AISummarizationProvider,
    AITask,
    AITranslationProvider,
    EmbeddingResult,
    EmbedOptions,
    SummarizationResult,
    SummarizeOptions,
    TranslateOptions,
    TranslationResult,
} from "../types";

const SUPPORTED_TASKS: AITask[] = ["embed", "summarize", "translate"];

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

interface OllamaEmbedResponse {
    embeddings: number[][];
}

interface OllamaTagsResponse {
    models: Array<{ name: string; model: string; size: number }>;
}

export interface AIOllamaProviderOptions {
    /** Ollama API URL. Default: http://localhost:11434 */
    baseUrl?: string;
    /** Default model for embedding. Default: nomic-embed-text */
    defaultModel?: string;
    /** Default model for LLM chat tasks (summarize, translate). Default: llama3.2 */
    defaultLlmModel?: string;
}

export class AIOllamaProvider
    implements AIProvider, AIEmbeddingProvider, AISummarizationProvider, AITranslationProvider
{
    readonly type = "ollama" as const;
    private _dimensions: number;
    private baseUrl: string;
    private defaultModel: string;
    private defaultLlmModel: string;
    private available: boolean | null = null;

    constructor(options?: AIOllamaProviderOptions) {
        this.baseUrl = (options?.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
        this.defaultModel = options?.defaultModel ?? "nomic-embed-text";
        this.defaultLlmModel = options?.defaultLlmModel ?? "llama3.2";
        // Default dimensions for nomic-embed-text. Updated from first actual response.
        this._dimensions = 768;
    }

    get dimensions(): number {
        return this._dimensions;
    }

    async isAvailable(): Promise<boolean> {
        if (this.available !== null) {
            return this.available;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const resp = await fetch(`${this.baseUrl}/api/tags`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            this.available = resp.ok;
            return this.available;
        } catch {
            this.available = false;
            return false;
        }
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    /** List available models on the Ollama server */
    async listModels(): Promise<string[]> {
        const resp = await fetch(`${this.baseUrl}/api/tags`);

        if (!resp.ok) {
            throw new Error(`Ollama /api/tags failed: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as OllamaTagsResponse;
        return data.models.map((m) => m.name);
    }

    /** Check if a specific model is available */
    async hasModel(model: string): Promise<boolean> {
        try {
            const models = await this.listModels();
            return models.some((m) => m === model || m.startsWith(`${model}:`));
        } catch {
            return false;
        }
    }

    /** Pull a model if it's not already available */
    async ensureModel(model: string): Promise<void> {
        if (await this.hasModel(model)) {
            return;
        }

        const resp = await fetch(`${this.baseUrl}/api/pull`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ model }),
        });

        if (!resp.ok) {
            throw new Error(`Failed to pull model "${model}": ${resp.status} ${resp.statusText}`);
        }

        // Stream the response to completion (Ollama streams pull progress)
        const reader = resp.body?.getReader();

        if (reader) {
            while (true) {
                const { done } = await reader.read();

                if (done) {
                    break;
                }
            }
        }
    }

    private async chat(messages: Array<{ role: string; content: string }>, model?: string): Promise<string> {
        const resp = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                model: model ?? this.defaultLlmModel,
                messages,
                stream: false,
            }),
        });

        if (!resp.ok) {
            throw new Error(`Ollama /api/chat failed: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as { message: { content: string } };
        return data.message.content;
    }

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        const maxLength = options?.maxLength ? ` Keep it under ${options.maxLength} characters.` : "";
        const summary = await this.chat(
            [
                { role: "system", content: `Summarize the following text concisely.${maxLength}` },
                { role: "user", content: text },
            ],
            options?.model
        );

        return { summary, originalLength: text.length };
    }

    async translate(text: string, options: TranslateOptions): Promise<TranslationResult> {
        const fromLang = options.from ? ` from ${options.from}` : "";
        const result = await this.chat(
            [
                {
                    role: "system",
                    content: `Translate the following text${fromLang} to ${options.to}. Return only the translation.`,
                },
                { role: "user", content: text },
            ],
            options.model
        );

        return { text: result, from: options.from ?? "auto", to: options.to };
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const results = await this.embedBatch([text], options);
        return results[0];
    }

    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const model = options?.model ?? this.defaultModel;

        const resp = await fetch(`${this.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                model,
                input: texts,
            }),
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Ollama /api/embed failed: ${resp.status} ${resp.statusText} -- ${body}`);
        }

        const data = (await resp.json()) as OllamaEmbedResponse;

        const results = data.embeddings.map((embedding) => {
            const vector = new Float32Array(embedding);
            return { vector, dimensions: vector.length };
        });

        // Update dimensions from actual model output on first successful call
        if (results.length > 0 && results[0].dimensions !== this._dimensions) {
            this._dimensions = results[0].dimensions;
        }

        return results;
    }

    dispose(): void {
        // No resources to clean up -- stateless HTTP client
    }
}
