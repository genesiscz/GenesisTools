import { describe, expect, test } from "bun:test";
import {
    findModel,
    getEmbeddingProviderTypes,
    getEmbedModelsForType,
    getMaxEmbedChars,
    getModelsByProvider,
    getModelsForTask,
    getTaskPrefix,
} from "./ModelRegistry";

/**
 * Pins the registry's observable behavior BEFORE the Phase 6 descriptor
 * extraction, so the move can be proven data-preserving. Values were captured
 * from the pre-move `ModelRegistry.ts` (671-line data blob) — treat any change
 * here as a behavior change that needs a stated reason, not a rebaseline.
 */

const EMBED_IDS = [
    "jinaai/CodeRankEmbed",
    "nomic-ai/nomic-embed-code-v1",
    "nvidia/NV-EmbedCode-7b-v1",
    "jinaai/jina-embeddings-v3",
    "text-embedding-3-small",
    "text-embedding-3-large",
    "darwinkit",
    "coreml-contextual",
    "Xenova/all-MiniLM-L6-v2",
    "nomic-embed-text",
    "all-minilm",
    "mxbai-embed-large",
    "gemini-embedding-001",
    "nomic-ai/nomic-embed-text-v1.5",
    "Snowflake/snowflake-arctic-embed-l-v2.0",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    "Xenova/multilingual-e5-small",
    "onnx-community/gte-multilingual-base",
    "Xenova/bge-m3",
    "Xenova/multilingual-e5-base",
    "Xenova/multilingual-e5-large",
    "ibm-granite/granite-embedding-278m-multilingual",
    "snowflake-arctic-embed:137m",
];

const TRANSCRIBE_IDS = [
    "distil-whisper/distil-large-v3",
    "onnx-community/whisper-large-v3-turbo",
    "Xenova/whisper-large-v3",
    "onnx-community/whisper-small",
    "onnx-community/whisper-base",
    "onnx-community/whisper-tiny",
    "whisper-large-v3-turbo",
    "whisper-large-v3",
    "whisper-1",
];

const TRANSLATE_IDS = [
    "Xenova/opus-mt-cs-en",
    "Xenova/opus-mt-en-cs",
    "Xenova/nllb-200-distilled-600M",
    "Xenova/m2m100_418M",
];

const SUMMARIZE_IDS = ["Xenova/distilbart-cnn-6-6"];

const TTS_IDS = ["onnx-community/Kokoro-82M-v1.0-ONNX", "onnx-community/chatterbox-multilingual-ONNX"];

const CODE_ORDER = [
    "nomic-embed-text",
    "snowflake-arctic-embed:137m",
    "jinaai/CodeRankEmbed",
    "nomic-ai/nomic-embed-code-v1",
    "nvidia/NV-EmbedCode-7b-v1",
    "jinaai/jina-embeddings-v3",
    "gemini-embedding-001",
    "text-embedding-3-large",
    "all-minilm",
    "mxbai-embed-large",
    "coreml-contextual",
    "Xenova/all-MiniLM-L6-v2",
    "nomic-ai/nomic-embed-text-v1.5",
    "Snowflake/snowflake-arctic-embed-l-v2.0",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    "Xenova/multilingual-e5-small",
    "onnx-community/gte-multilingual-base",
    "Xenova/bge-m3",
    "Xenova/multilingual-e5-base",
    "Xenova/multilingual-e5-large",
    "ibm-granite/granite-embedding-278m-multilingual",
    "darwinkit",
    "text-embedding-3-small",
];

const MAIL_ORDER = [
    "mxbai-embed-large",
    "snowflake-arctic-embed:137m",
    "coreml-contextual",
    "jinaai/jina-embeddings-v3",
    "Snowflake/snowflake-arctic-embed-l-v2.0",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    "Xenova/multilingual-e5-small",
    "onnx-community/gte-multilingual-base",
    "Xenova/bge-m3",
    "Xenova/multilingual-e5-base",
    "Xenova/multilingual-e5-large",
    "ibm-granite/granite-embedding-278m-multilingual",
    "darwinkit",
    "text-embedding-3-small",
    "text-embedding-3-large",
    "nomic-embed-text",
    "all-minilm",
    "jinaai/CodeRankEmbed",
    "nomic-ai/nomic-embed-code-v1",
    "nvidia/NV-EmbedCode-7b-v1",
    "Xenova/all-MiniLM-L6-v2",
    "nomic-ai/nomic-embed-text-v1.5",
    "gemini-embedding-001",
];

const CHAT_ORDER = [
    "nomic-embed-text",
    "all-minilm",
    "mxbai-embed-large",
    "snowflake-arctic-embed:137m",
    "coreml-contextual",
    "jinaai/jina-embeddings-v3",
    "Xenova/all-MiniLM-L6-v2",
    "nomic-ai/nomic-embed-text-v1.5",
    "Snowflake/snowflake-arctic-embed-l-v2.0",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    "Xenova/multilingual-e5-small",
    "onnx-community/gte-multilingual-base",
    "Xenova/bge-m3",
    "Xenova/multilingual-e5-base",
    "Xenova/multilingual-e5-large",
    "ibm-granite/granite-embedding-278m-multilingual",
    "darwinkit",
    "text-embedding-3-small",
    "gemini-embedding-001",
    "text-embedding-3-large",
    "jinaai/CodeRankEmbed",
    "nomic-ai/nomic-embed-code-v1",
    "nvidia/NV-EmbedCode-7b-v1",
];

describe("ModelRegistry data parity", () => {
    test("getModelsForTask returns the same ids in the same order per task", () => {
        expect(getModelsForTask("embed").map((m) => m.id)).toEqual(EMBED_IDS);
        expect(getModelsForTask("transcribe").map((m) => m.id)).toEqual(TRANSCRIBE_IDS);
        expect(getModelsForTask("translate").map((m) => m.id)).toEqual(TRANSLATE_IDS);
        expect(getModelsForTask("summarize").map((m) => m.id)).toEqual(SUMMARIZE_IDS);
    });

    test("TTS entries stay in the master array even though nothing asks for the task", () => {
        expect(getModelsForTask("tts" as never).map((m) => m.id)).toEqual(TTS_IDS);

        for (const id of TTS_IDS) {
            expect(findModel(id)?.task).toBe("tts");
        }

        expect(getModelsByProvider("tts" as never, "local-hf").map((m) => m.id)).toEqual(TTS_IDS);
    });

    test("getModelsByProvider filters on task and provider", () => {
        expect(getModelsByProvider("transcribe", "local-hf").map((m) => m.id)).toEqual([
            "distil-whisper/distil-large-v3",
            "onnx-community/whisper-large-v3-turbo",
            "Xenova/whisper-large-v3",
            "onnx-community/whisper-small",
            "onnx-community/whisper-base",
            "onnx-community/whisper-tiny",
        ]);
        expect(getModelsByProvider("translate", "openai")).toEqual([]);
    });

    test("getEmbeddingProviderTypes covers every provider with an embed model", () => {
        expect([...getEmbeddingProviderTypes()].sort()).toEqual([
            "cloud",
            "coreml",
            "darwinkit",
            "google",
            "local-hf",
            "ollama",
            "openai",
        ]);
    });

    test("findModel falls back to the base id for tagged ollama ids", () => {
        expect(findModel("nomic-embed-text")?.id).toBe("nomic-embed-text");
        expect(findModel("nomic-embed-text:v1.5")?.id).toBe("nomic-embed-text");
        expect(findModel("does/not-exist")).toBeUndefined();
    });
});

describe("getMaxEmbedChars", () => {
    test("computes contextLength * charsPerToken for registered models", () => {
        expect(getMaxEmbedChars("jinaai/CodeRankEmbed")).toBe(1024);
        expect(getMaxEmbedChars("nomic-ai/nomic-embed-code-v1")).toBe(4096);
        expect(getMaxEmbedChars("jinaai/jina-embeddings-v3")).toBe(24576);
        expect(getMaxEmbedChars("text-embedding-3-small")).toBe(32764);
        expect(getMaxEmbedChars("text-embedding-3-large")).toBe(32764);
        expect(getMaxEmbedChars("gemini-embedding-001")).toBe(6144);
        expect(getMaxEmbedChars("darwinkit")).toBe(2048);
        expect(getMaxEmbedChars("coreml-contextual")).toBe(2048);
        expect(getMaxEmbedChars("mxbai-embed-large")).toBe(1536);
        expect(getMaxEmbedChars("snowflake-arctic-embed:137m")).toBe(24576);
    });

    test("models without contextLength fall through to the 512 * 3 default", () => {
        expect(getMaxEmbedChars("Xenova/multilingual-e5-small")).toBe(1536);
        expect(getMaxEmbedChars("onnx-community/whisper-tiny")).toBe(1536);
        expect(getMaxEmbedChars("totally/unknown")).toBe(1536);
    });

    test("unregistered ids use the fallback context-length table, base id first", () => {
        expect(getMaxEmbedChars("snowflake-arctic-embed:latest")).toBe(1536);
        expect(getMaxEmbedChars("text-embedding-ada-002")).toBe(24573);
    });
});

describe("getTaskPrefix", () => {
    test("returns the registered prefix", () => {
        expect(getTaskPrefix("nomic-ai/nomic-embed-code-v1")).toEqual({
            document: "search_document: ",
            query: "search_query: ",
        });
        expect(getTaskPrefix("jinaai/jina-embeddings-v3")).toEqual({
            document: "search_document: ",
            query: "search_query: ",
        });
        expect(getTaskPrefix("nomic-embed-text")).toEqual({
            document: "search_document: ",
            query: "search_query: ",
        });
        expect(getTaskPrefix("nomic-ai/nomic-embed-text-v1.5")).toEqual({
            document: "search_document: ",
            query: "search_query: ",
        });
    });

    test("falls back to the base-id table for tagged ids and null otherwise", () => {
        expect(getTaskPrefix("nomic-embed-code:latest")).toEqual({
            document: "search_document: ",
            query: "search_query: ",
        });
        expect(getTaskPrefix("Xenova/bge-m3")).toBeNull();
        expect(getTaskPrefix("totally/unknown")).toBeNull();
    });
});

describe("getEmbedModelsForType", () => {
    test("code and files share the code ordering", () => {
        expect(getEmbedModelsForType("code").map((m) => m.id)).toEqual(CODE_ORDER);
        expect(getEmbedModelsForType("files").map((m) => m.id)).toEqual(CODE_ORDER);
    });

    test("mail and chat have their own orderings", () => {
        expect(getEmbedModelsForType("mail").map((m) => m.id)).toEqual(MAIL_ORDER);
        expect(getEmbedModelsForType("chat").map((m) => m.id)).toEqual(CHAT_ORDER);
    });

    test("only embed models are returned, and the source array is not mutated", () => {
        const first = getEmbedModelsForType("mail").map((m) => m.id);
        expect(getEmbedModelsForType("code").map((m) => m.id)).toEqual(CODE_ORDER);
        expect(getEmbedModelsForType("mail").map((m) => m.id)).toEqual(first);

        for (const model of getEmbedModelsForType("chat")) {
            expect(model.task).toBe("embed");
        }
    });
});
