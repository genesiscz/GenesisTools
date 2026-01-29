export interface ConversionOptions {
    baseUrl: string;
    depth: "basic" | "advanced";
    preserveImages?: boolean;
    preserveTables?: boolean;
    maxTokens?: number;
}

export interface ConversionResult {
    markdown: string;
    metadata: {
        title?: string;
        author?: string;
        publishedTime?: string;
        url: string;
    };
    metrics: {
        inputChars: number;
        outputChars: number;
        conversionTimeMs: number;
    };
}

export interface ValidationResult {
    valid: boolean;
    issues: string[];
    htmlTagsRemaining: number;
    emptyLinks: number;
    unclosedCodeBlocks: boolean;
}

export type EngineName = "turndown" | "mdream" | "readerlm";
