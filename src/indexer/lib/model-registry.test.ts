import { describe, expect, it } from "bun:test";
import { formatModelTable, getModelsForType, MODEL_REGISTRY } from "./model-registry";

describe("MODEL_REGISTRY", () => {
    it("contains 8 models", () => {
        expect(MODEL_REGISTRY.length).toBe(8);
    });

    it("each model has required fields", () => {
        for (const model of MODEL_REGISTRY) {
            expect(model.id).toBeTruthy();
            expect(model.name).toBeTruthy();
            expect(model.dimensions).toBeGreaterThan(0);
            expect(model.bestFor.length).toBeGreaterThan(0);
            expect(["fast", "medium", "slow"]).toContain(model.speed);
            expect(["local-hf", "cloud", "darwinkit"]).toContain(model.provider);
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
