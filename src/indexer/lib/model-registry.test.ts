import { describe, expect, it } from "bun:test";
import {
    formatModelTable,
    getMaxEmbedChars,
    getModelsForType,
    getTaskPrefix,
    MODEL_CONTEXT_LENGTHS,
    MODEL_REGISTRY,
    TASK_PREFIXES,
} from "./model-registry";

describe("MODEL_REGISTRY", () => {
    it("contains expected number of models", () => {
        expect(MODEL_REGISTRY.length).toBeGreaterThanOrEqual(8);
    });

    it("each model has required fields", () => {
        for (const model of MODEL_REGISTRY) {
            expect(model.id).toBeTruthy();
            expect(model.name).toBeTruthy();
            expect(model.dimensions).toBeGreaterThan(0);
            expect(model.bestFor.length).toBeGreaterThan(0);
            expect(["fast", "medium", "slow"]).toContain(model.speed);
            expect(["local-hf", "cloud", "darwinkit", "coreml", "ollama"]).toContain(model.provider);
        }
    });

    it("has unique model IDs", () => {
        const ids = MODEL_REGISTRY.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe("getModelsForType", () => {
    it("returns code models first for type 'code'", () => {
        const models = getModelsForType("code");
        expect(models.length).toBe(MODEL_REGISTRY.length);

        const firstCodeIdx = models.findIndex((m) => m.bestFor.includes("code"));
        const firstNonCodeIdx = models.findIndex((m) => !m.bestFor.includes("code"));

        if (firstNonCodeIdx !== -1) {
            expect(firstCodeIdx).toBeLessThan(firstNonCodeIdx);
        }
    });

    it("returns code models first for type 'files'", () => {
        const models = getModelsForType("files");
        const firstCodeIdx = models.findIndex((m) => m.bestFor.includes("code"));
        const firstNonCodeIdx = models.findIndex((m) => !m.bestFor.includes("code"));

        if (firstNonCodeIdx !== -1) {
            expect(firstCodeIdx).toBeLessThan(firstNonCodeIdx);
        }
    });

    it("returns mail models first for type 'mail'", () => {
        const models = getModelsForType("mail");
        const firstMailIdx = models.findIndex((m) => m.bestFor.includes("mail"));
        const firstNonMailIdx = models.findIndex((m) => !m.bestFor.includes("mail"));

        if (firstNonMailIdx !== -1) {
            expect(firstMailIdx).toBeLessThan(firstNonMailIdx);
        }
    });

    it("returns general models first for type 'chat'", () => {
        const models = getModelsForType("chat");
        const firstGeneralIdx = models.findIndex((m) => m.bestFor.includes("general"));
        const firstNonGeneralIdx = models.findIndex((m) => !m.bestFor.includes("general"));

        if (firstNonGeneralIdx !== -1) {
            expect(firstGeneralIdx).toBeLessThan(firstNonGeneralIdx);
        }
    });

    it("returns all models regardless of type", () => {
        for (const type of ["code", "files", "mail", "chat"] as const) {
            expect(getModelsForType(type).length).toBe(MODEL_REGISTRY.length);
        }
    });
});

describe("formatModelTable", () => {
    it("produces table with headers", () => {
        const table = formatModelTable(MODEL_REGISTRY);
        expect(table).toContain("Name");
        expect(table).toContain("Params");
        expect(table).toContain("Dims");
        expect(table).toContain("RAM");
        expect(table).toContain("Speed");
        expect(table).toContain("License");
        expect(table).toContain("Best For");
    });

    it("includes all model names", () => {
        const table = formatModelTable(MODEL_REGISTRY);

        for (const model of MODEL_REGISTRY) {
            expect(table).toContain(model.name);
        }
    });

    it("handles empty array", () => {
        const table = formatModelTable([]);
        expect(table).toContain("Name");
        const lines = table.split("\n");
        // Header + separator only
        expect(lines.length).toBe(2);
    });

    it("shows cloud/built-in for zero-RAM models", () => {
        const table = formatModelTable(MODEL_REGISTRY);
        expect(table).toContain("cloud");
        expect(table).toContain("built-in");
    });
});

describe("getMaxEmbedChars", () => {
    it("returns correct chars for registered model", () => {
        // nomic-embed-code: 2048 tokens * 2 chars/token = 4096
        const chars = getMaxEmbedChars("nomic-ai/nomic-embed-code-v1");
        expect(chars).toBe(4096);
    });

    it("returns correct chars for OpenAI model", () => {
        // 8191 tokens * 4 chars/token = 32764
        const chars = getMaxEmbedChars("text-embedding-3-small");
        expect(chars).toBe(32764);
    });

    it("returns fallback for unknown model", () => {
        const chars = getMaxEmbedChars("totally-unknown-model");
        // DEFAULT_CONTEXT_LENGTH (512) * DEFAULT_CHARS_PER_TOKEN (3) = 1536
        expect(chars).toBe(1536);
    });

    it("strips Ollama-style tags and finds registry entry", () => {
        const chars = getMaxEmbedChars("nomic-embed-text:latest");
        // Registry: nomic-embed-text has 2048 tokens * 2 chars/token = 4096
        expect(chars).toBe(4096);
    });

    it("MODEL_CONTEXT_LENGTHS has fallback entries for non-registry models", () => {
        expect(MODEL_CONTEXT_LENGTHS["snowflake-arctic-embed"]).toBe(512);
        expect(MODEL_CONTEXT_LENGTHS["text-embedding-3-large"]).toBe(8191);
        expect(MODEL_CONTEXT_LENGTHS["text-embedding-ada-002"]).toBe(8191);
    });
});

describe("getTaskPrefix", () => {
    it("returns prefix for nomic model", () => {
        const prefix = getTaskPrefix("nomic-ai/nomic-embed-code-v1");
        expect(prefix).toEqual({ document: "search_document: ", query: "search_query: " });
    });

    it("returns prefix for Ollama-style nomic", () => {
        const prefix = getTaskPrefix("nomic-embed-text:latest");
        expect(prefix).toEqual({ document: "search_document: ", query: "search_query: " });
    });

    it("returns null for models without prefixes", () => {
        const prefix = getTaskPrefix("text-embedding-3-small");
        expect(prefix).toBeNull();
    });

    it("returns null for unknown models", () => {
        const prefix = getTaskPrefix("totally-unknown-model");
        expect(prefix).toBeNull();
    });

    it("TASK_PREFIXES has fallback entries for non-registry models", () => {
        expect(TASK_PREFIXES["nomic-embed-code"]).toBeTruthy();
    });
});
