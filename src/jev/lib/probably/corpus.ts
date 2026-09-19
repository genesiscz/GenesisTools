import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export type CorpusExample = {
    name: string;
    file: string;
    input: string;
    source: string;
};

const LANGUAGE_GUIDE = `# Probably 0.1 (GenesisTools lab)

A small experimental language for LLM workflows. Jev supplies judgments; the default
chat model supplies generated strings via \`llm\`/\`write\`. The interpreter owns
variables, branches, loops, budgets, output and replay — source is never evaluated
as JavaScript.

## Constructs

| Construct | Meaning |
|---|---|
| \`let name = value\` | Declare a block-scoped variable |
| \`name = value\` | Update an existing variable |
| \`input()\` | Read the program's input string |
| \`print(value)\` | Append output |
| \`llm "instruction" using value\` | Call the chat model; \`using\` is optional |
| \`if value feels "description" { ... }\` | Ask Jev; take the highest-probability yes/no branch |
| \`with confidence 80%\` | Require the winning branch's probability to reach 80% |
| \`otherwise maybe { ... }\` | Handle a result below the confidence threshold |
| \`else { ... }\` | Handle a confident negative answer |
| \`match value { "label" => { ... } ... }\` | Choose between 2–8 semantic labels |
| \`while value feels "description" { ... }\` | Reevaluate after each iteration; at most five |
| \`repeat 3 { ... }\` | Run a block a fixed 1–5 times |
| \`chaos { ... }\` | Sample judgment probabilities inside the block |
| \`// comment\` | Comment to end of line |

Values are strings, numbers or booleans. No objects, functions, arithmetic, imports,
host-language evaluation or external tools. Every run is limited to 12 model effects,
200 executed statements and 90 seconds.

## Storage

Programs live under \`~/.genesis-tools/jev/probably/programs/<name>.prob\`.

\`\`\`sh
tools jev evaluation create                 # this guide + corpus
tools jev evaluation create --name hello --from path/to/hello.prob
tools jev evaluation list
tools jev evaluation show hello
tools jev evaluation run hello --input "…"
tools jev evaluation run hello --input @./message.txt
tools jev evaluation run hello --replay recording.json
\`\`\`

This is a fun lab under \`tools jev\`, not a production runtime.
`;

export function languageGuide(): string {
    return LANGUAGE_GUIDE;
}

export function examplesDir(): string {
    return join(import.meta.dir, "examples");
}

export function loadCorpus(): CorpusExample[] {
    const path = join(examplesDir(), "corpus.json");
    const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

    if (!Array.isArray(raw)) {
        throw new Error("Probably corpus.json must be an array.");
    }

    return raw as CorpusExample[];
}

export function readBundledExample(file: string): string {
    const base = file.replace(/\.prob$/i, "");
    const safe = /^[a-z0-9_-]+$/i.test(base) ? base : null;

    if (!safe) {
        throw new Error(`Invalid bundled example name: ${file}`);
    }

    return readFileSync(join(examplesDir(), `${safe}.prob`), "utf8");
}

export function createPayload(): {
    guide: string;
    corpus: Array<{ name: string; file: string; input: string; sourcePreview: string }>;
    storeHint: string;
} {
    const corpus = loadCorpus().map((example) => ({
        name: example.name,
        file: example.file,
        input: example.input,
        sourcePreview: example.source.length > 280 ? `${example.source.slice(0, 280)}…` : example.source,
    }));

    return {
        guide: languageGuide(),
        corpus,
        storeHint: "~/.genesis-tools/jev/probably/programs/<name>.prob",
    };
}
