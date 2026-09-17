import { join, resolve } from "node:path";
import type { CompilerPlan, LanguageCompiler } from "./types";

export class TypeScriptCompiler implements LanguageCompiler {
    readonly languageId = "typescript";

    async prepare(sourceFile: string): Promise<CompilerPlan> {
        const root = resolve(import.meta.dir, "../../../..");
        const checker = join(
            root,
            "node_modules",
            "@typescript",
            `native-preview-${process.platform}-${process.arch}`,
            "lib",
            process.platform === "win32" ? "tsgo.exe" : "tsgo"
        );
        if (!(await Bun.file(checker).exists())) {
            throw new Error("TypeScript checker is missing. Run bun install in GenesisTools.");
        }

        return {
            label: "TypeScript / Bun",
            readPaths: [join(root, "node_modules")],
            check: [
                checker,
                "--ignoreConfig",
                "--noEmit",
                "--skipLibCheck",
                "--target",
                "esnext",
                "--module",
                "esnext",
                "--moduleResolution",
                "bundler",
                "--types",
                "bun",
                "--typeRoots",
                join(root, "node_modules/@types"),
                sourceFile,
            ],
            execute: [process.execPath, "run", sourceFile],
        };
    }
}
