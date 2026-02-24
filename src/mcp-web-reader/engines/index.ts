import type { MarkdownEngine } from "./base.js";
import { MdreamEngine } from "./mdream.js";
import { ReaderLMEngine } from "./readerlm.js";
import { TurndownEngine } from "./turndown.js";
import type { EngineName } from "./types.js";

const engines: Record<EngineName, () => MarkdownEngine> = {
    turndown: () => new TurndownEngine(),
    mdream: () => new MdreamEngine(),
    readerlm: () => new ReaderLMEngine(),
};

export function getEngine(name: EngineName): MarkdownEngine {
    const factory = engines[name];
    if (!factory) {
        throw new Error(`Unknown engine: ${name}`);
    }
    return factory();
}

export function listEngines(): Array<{ name: EngineName; description: string }> {
    return [
        { name: "turndown", description: "Turndown + GFM - customizable, good for complex docs" },
        { name: "mdream", description: "mdream - fast, token-efficient, LLM-optimized" },
        { name: "readerlm", description: "get-md - LLM-optimized, Readability + Turndown" },
    ];
}

export { MarkdownEngine } from "./base.js";
export * from "./types.js";
