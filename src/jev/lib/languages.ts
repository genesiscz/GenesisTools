import type { ExperimentLanguage, ExperimentRequest, ProgramState } from "./experiment-contract";
import { typescriptState } from "./typescript-grammar";

export class TypeScriptLanguage implements ExperimentLanguage {
    readonly id = "typescript";
    readonly name = "TypeScript";
    readonly fileExtension = "ts";
    readonly generationInstructions = "Use console.log for output and await Bun.stdin.text() for stdin.";

    state(request: ExperimentRequest): ProgramState {
        return typescriptState(request);
    }
}

export class LanguageRegistry {
    private readonly languages = new Map<string, ExperimentLanguage>();

    register(language: ExperimentLanguage): this {
        if (this.languages.has(language.id)) {
            throw new Error(`Language already registered: ${language.id}`);
        }

        this.languages.set(language.id, language);
        return this;
    }

    get(id: string): ExperimentLanguage {
        const language = this.languages.get(id);
        if (!language) {
            throw new Error(`Unsupported experiment language: ${id}`);
        }

        return language;
    }

    list(): ExperimentLanguage[] {
        return [...this.languages.values()];
    }
}

export const languages = new LanguageRegistry().register(new TypeScriptLanguage());
