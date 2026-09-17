import type { LanguageCompiler } from "./types";
import { TypeScriptCompiler } from "./typescript";

export class CompilerRegistry {
    private readonly drivers = new Map<string, LanguageCompiler>();

    register(driver: LanguageCompiler): this {
        if (this.drivers.has(driver.languageId)) {
            throw new Error(`Compiler already registered: ${driver.languageId}`);
        }

        this.drivers.set(driver.languageId, driver);
        return this;
    }

    get(languageId: string): LanguageCompiler {
        const compiler = this.drivers.get(languageId);
        if (!compiler) {
            throw new Error(`No compiler registered for language: ${languageId}`);
        }

        return compiler;
    }
}

export const compilers = new CompilerRegistry().register(new TypeScriptCompiler());
