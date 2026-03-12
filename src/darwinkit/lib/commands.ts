import type { EmbedType, NlpScheme, OcrLevel } from "@app/utils/macos";
import {
    analyzeSentiment,
    areSimilar,
    authenticate,
    batchSentiment,
    checkBiometry,
    classifyBatch,
    classifyText,
    clusterBySimilarity,
    deduplicateTexts,
    detectLanguage,
    embedText,
    extractEntities,
    extractText,
    findNeighbors,
    getCapabilities,
    getKeywords,
    groupByCategory,
    groupByLanguage,
    icloudCopy,
    icloudDelete,
    icloudList,
    icloudMkdir,
    icloudMove,
    icloudRead,
    icloudStartMonitoring,
    icloudStatus,
    icloudStopMonitoring,
    icloudWrite,
    icloudWriteBytes,
    lemmatize,
    listVoices,
    rankBySimilarity,
    recognizeText,
    scoreRelevance,
    speak,
    tagText,
    textDistance,
} from "@app/utils/macos";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ParamDef {
    name: string;
    type: "string" | "number" | "boolean" | "string[]";
    required: boolean;
    description: string;
    default?: unknown;
    /** If true, this is the first positional argument (not a flag) */
    positional?: boolean;
    /** For select prompts in interactive mode */
    choices?: string[];
}

export interface CommandDef {
    /** CLI subcommand name, e.g. "detect-language" */
    name: string;
    /** Interactive menu group, e.g. "nlp" */
    group: string;
    /** One-line description for help & interactive menu */
    description: string;
    /** Parameter definitions — drive help, validation, and interactive prompts */
    params: ParamDef[];
    /** Execute the command. Receives validated args, returns result to be formatted. */
    run: (args: Record<string, unknown>) => Promise<unknown>;
}

// ─── Group Labels ───────────────────────────────────────────────────────────────

export const GROUP_LABELS: Record<string, string> = {
    nlp: "Natural Language Processing",
    vision: "Computer Vision",
    "text-analysis": "Text Analysis (batch)",
    classification: "Classification",
    tts: "Text-to-Speech",
    auth: "Authentication",
    icloud: "iCloud Drive",
    system: "System",
};

export const GROUP_ORDER = ["nlp", "vision", "text-analysis", "classification", "tts", "auth", "icloud", "system"];

// ─── Command Registry ───────────────────────────────────────────────────────────

export const commands: CommandDef[] = [
    // ── NLP ──────────────────────────────────────────────────────────────────
    {
        name: "detect-language",
        group: "nlp",
        description: "Detect the language of text (BCP-47 code + confidence)",
        params: [{ name: "text", type: "string", required: true, positional: true, description: "Text to analyze" }],
        run: async (args) => detectLanguage(args.text as string),
    },
    {
        name: "sentiment",
        group: "nlp",
        description: "Analyze sentiment — score (-1 to 1) and label",
        params: [{ name: "text", type: "string", required: true, positional: true, description: "Text to analyze" }],
        run: async (args) => analyzeSentiment(args.text as string),
    },
    {
        name: "tag",
        group: "nlp",
        description: "Tag text with POS, NER, lemma, or other schemes",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to tag" },
            {
                name: "schemes",
                type: "string[]",
                required: false,
                description: "Tagging schemes",
                default: ["lexicalClass"],
                choices: ["lexicalClass", "nameType", "lemma", "sentimentScore", "language"],
            },
            { name: "language", type: "string", required: false, description: "BCP-47 language code" },
        ],
        run: async (args) =>
            tagText(
                args.text as string,
                (args.schemes as NlpScheme[] | undefined) ?? ["lexicalClass"],
                args.language as string | undefined
            ),
    },
    {
        name: "entities",
        group: "nlp",
        description: "Extract named entities (people, places, organizations)",
        params: [{ name: "text", type: "string", required: true, positional: true, description: "Text to analyze" }],
        run: async (args) => extractEntities(args.text as string),
    },
    {
        name: "lemmatize",
        group: "nlp",
        description: "Get root/dictionary form of each word",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to lemmatize" },
            { name: "language", type: "string", required: false, description: "BCP-47 language code" },
        ],
        run: async (args) => lemmatize(args.text as string, args.language as string | undefined),
    },
    {
        name: "keywords",
        group: "nlp",
        description: "Extract important content words (nouns, verbs, adjectives)",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to analyze" },
            { name: "max", type: "number", required: false, description: "Max keywords to return", default: 10 },
        ],
        run: async (args) => getKeywords(args.text as string, (args.max as number) ?? 10),
    },
    {
        name: "embed",
        group: "nlp",
        description: "Compute 512-dim semantic embedding vector",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to embed" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
            {
                name: "type",
                type: "string",
                required: false,
                description: "Embedding type",
                default: "sentence",
                choices: ["word", "sentence"],
            },
        ],
        run: async (args) =>
            embedText(args.text as string, (args.language as string) ?? "en", (args.type as EmbedType) ?? "sentence"),
    },
    {
        name: "distance",
        group: "nlp",
        description: "Compute cosine distance between two texts (0 = identical, 2 = opposite)",
        params: [
            { name: "text1", type: "string", required: true, positional: true, description: "First text" },
            { name: "text2", type: "string", required: true, positional: true, description: "Second text" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) =>
            textDistance(args.text1 as string, args.text2 as string, (args.language as string) ?? "en"),
    },
    {
        name: "similar",
        group: "nlp",
        description: "Check if two texts are semantically similar (boolean)",
        params: [
            { name: "text1", type: "string", required: true, positional: true, description: "First text" },
            { name: "text2", type: "string", required: true, positional: true, description: "Second text" },
            { name: "threshold", type: "number", required: false, description: "Distance threshold", default: 0.5 },
        ],
        run: async (args) => areSimilar(args.text1 as string, args.text2 as string, (args.threshold as number) ?? 0.5),
    },
    {
        name: "relevance",
        group: "nlp",
        description: "Score semantic relevance of text against a query (0-1)",
        params: [
            { name: "query", type: "string", required: true, positional: true, description: "Query text" },
            { name: "text", type: "string", required: true, positional: true, description: "Text to score" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) =>
            scoreRelevance(args.query as string, args.text as string, (args.language as string) ?? "en"),
    },
    {
        name: "neighbors",
        group: "nlp",
        description: "Find semantically similar words or sentences",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Input text" },
            { name: "count", type: "number", required: false, description: "Number of neighbors", default: 5 },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
            {
                name: "type",
                type: "string",
                required: false,
                description: "Embed type",
                default: "word",
                choices: ["word", "sentence"],
            },
        ],
        run: async (args) =>
            findNeighbors(
                args.text as string,
                (args.count as number) ?? 5,
                (args.language as string) ?? "en",
                (args.type as EmbedType) ?? "word"
            ),
    },

    // ── Vision ───────────────────────────────────────────────────────────────
    {
        name: "ocr",
        group: "vision",
        description: "Extract text from an image file using Apple Vision",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "Path to image file" },
            {
                name: "languages",
                type: "string[]",
                required: false,
                description: "Recognition languages",
                default: ["en-US"],
            },
            {
                name: "level",
                type: "string",
                required: false,
                description: "Recognition level",
                default: "accurate",
                choices: ["accurate", "fast"],
            },
            {
                name: "text-only",
                type: "boolean",
                required: false,
                description: "Return plain text only (no bounding boxes)",
                default: false,
            },
        ],
        run: async (args) => {
            const path = args.path as string;
            const options = {
                languages: args.languages as string[] | undefined,
                level: (args.level as OcrLevel) ?? "accurate",
            };

            if (args["text-only"]) {
                return extractText(path, options);
            }

            return recognizeText(path, options);
        },
    },

    // ── Text Analysis (batch) ────────────────────────────────────────────────
    {
        name: "rank",
        group: "text-analysis",
        description: "Rank texts by semantic similarity to a query",
        params: [
            { name: "query", type: "string", required: true, positional: true, description: "Query to rank against" },
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to rank (comma-separated or multiple --items flags)",
            },
            { name: "max-results", type: "number", required: false, description: "Max results to return" },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text, i) => ({ text, id: String(i) }));
            return rankBySimilarity(args.query as string, items, {
                language: (args.language as string) ?? "en",
                maxResults: args["max-results"] as number | undefined,
            });
        },
    },
    {
        name: "batch-sentiment",
        group: "text-analysis",
        description: "Analyze sentiment for multiple texts",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to analyze (comma-separated)",
            },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text, i) => ({ text, id: String(i) }));
            return batchSentiment(items);
        },
    },
    {
        name: "group-by-language",
        group: "text-analysis",
        description: "Detect language for each text and group by language code",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to group (comma-separated)",
            },
            {
                name: "min-confidence",
                type: "number",
                required: false,
                description: "Min confidence threshold",
                default: 0.7,
            },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text, i) => ({ text, id: String(i) }));
            return groupByLanguage(items, {
                minConfidence: (args["min-confidence"] as number) ?? 0.7,
            });
        },
    },
    {
        name: "deduplicate",
        group: "text-analysis",
        description: "Remove semantically duplicate texts",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to deduplicate (comma-separated)",
            },
            {
                name: "threshold",
                type: "number",
                required: false,
                description: "Cosine distance threshold",
                default: 0.3,
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text) => ({ text }));
            const result = await deduplicateTexts(items, {
                threshold: (args.threshold as number) ?? 0.3,
                language: (args.language as string) ?? "en",
            });
            return result.map((r) => r.text);
        },
    },
    {
        name: "cluster",
        group: "text-analysis",
        description: "Group semantically similar texts into clusters",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to cluster (comma-separated)",
            },
            {
                name: "threshold",
                type: "number",
                required: false,
                description: "Distance threshold for same cluster",
                default: 0.5,
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text) => ({ text }));
            return clusterBySimilarity(items, {
                threshold: (args.threshold as number) ?? 0.5,
                language: (args.language as string) ?? "en",
            });
        },
    },

    // ── Classification ───────────────────────────────────────────────────────
    {
        name: "classify",
        group: "classification",
        description: "Classify text into one of N candidate categories",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to classify" },
            {
                name: "categories",
                type: "string[]",
                required: true,
                description: "Candidate categories (comma-separated)",
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) =>
            classifyText(args.text as string, args.categories as string[], {
                language: (args.language as string) ?? "en",
            }),
    },

    {
        name: "classify-batch",
        group: "classification",
        description: "Classify multiple texts into categories",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to classify (comma-separated)",
            },
            {
                name: "categories",
                type: "string[]",
                required: true,
                description: "Candidate categories (comma-separated)",
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text, i) => ({ text, id: String(i) }));
            return classifyBatch(items, args.categories as string[], {
                language: (args.language as string) ?? "en",
            });
        },
    },
    {
        name: "group-by-category",
        group: "classification",
        description: "Group texts by their classified category",
        params: [
            {
                name: "items",
                type: "string[]",
                required: true,
                description: "Texts to group (comma-separated)",
            },
            {
                name: "categories",
                type: "string[]",
                required: true,
                description: "Candidate categories (comma-separated)",
            },
            { name: "language", type: "string", required: false, description: "BCP-47 code", default: "en" },
        ],
        run: async (args) => {
            const items = (args.items as string[]).map((text) => ({ text }));
            return groupByCategory(items, args.categories as string[], {
                language: (args.language as string) ?? "en",
            });
        },
    },

    // ── TTS ──────────────────────────────────────────────────────────────────
    {
        name: "speak",
        group: "tts",
        description: "Speak text aloud using macOS say with auto language detection",
        params: [
            { name: "text", type: "string", required: true, positional: true, description: "Text to speak" },
            { name: "voice", type: "string", required: false, description: "Override voice name" },
            { name: "rate", type: "number", required: false, description: "Words per minute" },
        ],
        run: async (args) => {
            await speak(args.text as string, {
                voice: args.voice as string | undefined,
                rate: args.rate as number | undefined,
            });
            return { spoken: true };
        },
    },
    {
        name: "list-voices",
        group: "tts",
        description: "List available macOS speech synthesis voices",
        params: [],
        run: async () => listVoices(),
    },

    // ── Auth ─────────────────────────────────────────────────────────────────
    {
        name: "check-biometry",
        group: "auth",
        description: "Check if Touch ID / Optic ID is available",
        params: [],
        run: async () => checkBiometry(),
    },
    {
        name: "authenticate",
        group: "auth",
        description: "Authenticate using Touch ID / Optic ID",
        params: [
            {
                name: "reason",
                type: "string",
                required: false,
                positional: true,
                description: "Reason for auth prompt",
            },
        ],
        run: async (args) => authenticate(args.reason as string | undefined),
    },

    // ── iCloud ───────────────────────────────────────────────────────────────
    {
        name: "icloud-status",
        group: "icloud",
        description: "Check iCloud Drive availability and container URL",
        params: [],
        run: async () => icloudStatus(),
    },
    {
        name: "icloud-read",
        group: "icloud",
        description: "Read a text file from iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "File path in iCloud" },
        ],
        run: async (args) => icloudRead(args.path as string),
    },
    {
        name: "icloud-write",
        group: "icloud",
        description: "Write text to a file in iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "File path in iCloud" },
            { name: "content", type: "string", required: true, description: "Content to write" },
        ],
        run: async (args) => icloudWrite(args.path as string, args.content as string),
    },
    {
        name: "icloud-write-bytes",
        group: "icloud",
        description: "Write binary data (base64-encoded) to iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "File path in iCloud" },
            { name: "data", type: "string", required: true, description: "Base64-encoded data" },
        ],
        run: async (args) => icloudWriteBytes(args.path as string, args.data as string),
    },
    {
        name: "icloud-delete",
        group: "icloud",
        description: "Delete a file from iCloud Drive",
        params: [
            { name: "path", type: "string", required: true, positional: true, description: "File path to delete" },
        ],
        run: async (args) => icloudDelete(args.path as string),
    },
    {
        name: "icloud-move",
        group: "icloud",
        description: "Move/rename a file in iCloud Drive",
        params: [
            { name: "source", type: "string", required: true, positional: true, description: "Source path" },
            { name: "destination", type: "string", required: true, positional: true, description: "Destination path" },
        ],
        run: async (args) => icloudMove(args.source as string, args.destination as string),
    },
    {
        name: "icloud-copy",
        group: "icloud",
        description: "Copy a file in iCloud Drive",
        params: [
            { name: "source", type: "string", required: true, positional: true, description: "Source path" },
            { name: "destination", type: "string", required: true, positional: true, description: "Destination path" },
        ],
        run: async (args) => icloudCopy(args.source as string, args.destination as string),
    },
    {
        name: "icloud-list",
        group: "icloud",
        description: "List directory contents in iCloud Drive",
        params: [{ name: "path", type: "string", required: true, positional: true, description: "Directory path" }],
        run: async (args) => icloudList(args.path as string),
    },
    {
        name: "icloud-mkdir",
        group: "icloud",
        description: "Create a directory in iCloud Drive",
        params: [{ name: "path", type: "string", required: true, positional: true, description: "Directory path" }],
        run: async (args) => icloudMkdir(args.path as string),
    },
    {
        name: "icloud-start-monitoring",
        group: "icloud",
        description: "Start monitoring iCloud Drive for file changes",
        params: [],
        run: async () => icloudStartMonitoring(),
    },
    {
        name: "icloud-stop-monitoring",
        group: "icloud",
        description: "Stop monitoring iCloud Drive for file changes",
        params: [],
        run: async () => icloudStopMonitoring(),
    },

    // ── System ───────────────────────────────────────────────────────────────
    {
        name: "capabilities",
        group: "system",
        description: "Show DarwinKit version, OS, architecture, and available methods",
        params: [],
        run: async () => getCapabilities(),
    },
];

/** Get a command by name */
export function getCommand(name: string): CommandDef | undefined {
    return commands.find((c) => c.name === name);
}

/** Get commands grouped by group name */
export function getCommandsByGroup(): Map<string, CommandDef[]> {
    const groups = new Map<string, CommandDef[]>();

    for (const group of GROUP_ORDER) {
        groups.set(group, []);
    }

    for (const cmd of commands) {
        const list = groups.get(cmd.group);

        if (list) {
            list.push(cmd);
        }
    }

    return groups;
}
