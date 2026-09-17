export interface CompilerPlan {
    label: string;
    check: string[];
    execute: string[];
    readPaths: string[];
}

export interface LanguageCompiler {
    readonly languageId: string;
    prepare(sourceFile: string): Promise<CompilerPlan>;
}
