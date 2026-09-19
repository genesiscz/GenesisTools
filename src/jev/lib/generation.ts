import type { ExperimentLanguage, ExperimentRequest, ProgramState } from "./experiment-contract";

export interface GenerationMode {
    readonly id: string;
    state(language: ExperimentLanguage, request: ExperimentRequest): ProgramState;
    instruction(language: ExperimentLanguage): string;
}

export class GrammarTokenMode implements GenerationMode {
    readonly id = "grammar";
    state(language: ExperimentLanguage, request: ExperimentRequest): ProgramState {
        return language.state(request);
    }
    instruction(language: ExperimentLanguage): string {
        return `Choose exactly one legal next ${language.name} token. Choose <done> only when the goal is implemented. Prefer the shortest correct program.`;
    }
}

export class CharacterMode implements GenerationMode {
    readonly id = "characters";
    private readonly alphabet = [
        "\n",
        "\t",
        ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)),
    ];

    state(_language: ExperimentLanguage, request: ExperimentRequest): ProgramState {
        const tokens = request.tokens;
        const finished = tokens.at(-1) === "<done>";
        const characters = finished ? tokens.slice(0, -1) : tokens;
        if (characters.some((character) => !this.alphabet.includes(character))) {
            throw new Error("Character mode accepts one printable ASCII character, tab, or newline per step.");
        }

        const source = characters.join("");
        if (finished && !source.trim()) {
            throw new Error("An empty program cannot finish.");
        }

        return {
            source,
            tokens,
            candidates: finished ? [] : [...this.alphabet, ...(source.trim() ? ["<done>"] : [])],
            slot: finished ? "complete" : "character",
            complete: finished,
        };
    }
    instruction(language: ExperimentLanguage): string {
        return `Choose the next SINGLE CHARACTER of a ${language.name} program that fulfills the goal. Continue the exact source prefix. Each criterion is a JSON-encoded character: choose its option ID. There is no grammar filter or supplied vocabulary. Choose <done> only when the whole program is ready. Prefer the shortest correct solution. ${language.generationInstructions ?? ""}`;
    }
}

const modes: Record<ExperimentRequest["mode"], GenerationMode> = {
    grammar: new GrammarTokenMode(),
    characters: new CharacterMode(),
};

export function generationMode(mode: ExperimentRequest["mode"]): GenerationMode {
    return modes[mode];
}
