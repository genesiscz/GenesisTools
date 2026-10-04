import type { Options } from "recast";

/** The Prettier options `getRecastOptions` maps onto recast's printer. */
export interface FormatterConfig {
    arrowParens: "always" | "avoid";
    bracketSpacing: boolean;
    endOfLine: "lf" | "crlf";
    jsxBracketSameLine: boolean;
    jsxSingleQuote: boolean;
    trailingComma: "es5" | "none" | "all";
    printWidth: number;
    singleQuote: boolean;
    semi: boolean;
    tabWidth: number;
    useTabs: boolean;
}

/**
 * Default printer settings, written as a Prettier config: tabs, 4 wide, 140 columns, double quotes, es5
 * trailing commas. Pass the target project's own config to `getRecastOptions` so a reprinted file diffs cleanly.
 */
export const prettierConfig: FormatterConfig = {
    arrowParens: "always",
    bracketSpacing: true,
    endOfLine: "lf",
    jsxBracketSameLine: false,
    jsxSingleQuote: false,
    trailingComma: "es5",
    printWidth: 140,
    singleQuote: false,
    semi: true,
    tabWidth: 4,
    useTabs: true,
};

/**
 * Converts a Prettier-style config (default: `prettierConfig`) to recast print options, for
 * `root.toSource(getRecastOptions())`.
 */
export function getRecastOptions(config: FormatterConfig = prettierConfig): Options {
    return {
        quote: config.singleQuote ? "single" : "double",
        trailingComma: config.trailingComma !== "none",
        tabWidth: config.tabWidth,
        useTabs: config.useTabs,
        wrapColumn: config.printWidth,
        objectCurlySpacing: config.bracketSpacing,
        arrowParensAlways: config.arrowParens === "always",
        lineTerminator: config.endOfLine === "lf" ? "\n" : "\r\n",
        flowObjectCommas: true,
        arrayBracketSpacing: false,
        reuseWhitespace: false,
    };
}
