import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OfflineShareAssets {
    css: string;
    mermaid?: string;
}

let cssPromise: Promise<string> | undefined;
let mermaidPromise: Promise<string> | undefined;

async function offlineCss(): Promise<string> {
    const katexPath = fileURLToPath(import.meta.resolve("katex/dist/katex.min.css"));
    const highlightPath = fileURLToPath(import.meta.resolve("highlight.js/styles/atom-one-dark.min.css"));
    const [katex, highlight] = await Promise.all([readFile(katexPath, "utf8"), readFile(highlightPath, "utf8")]);
    const fonts = [...new Set([...katex.matchAll(/url\(fonts\/([^)]*\.woff2)\)/g)].map((match) => match[1]))];
    const replacements = await Promise.all(
        fonts.map(async (font) => {
            const bytes = await readFile(join(dirname(katexPath), "fonts", font));
            return [font, `url(data:font/woff2;base64,${bytes.toString("base64")})`] as const;
        })
    );
    let css = katex.replace(/,url\(fonts\/[^)]*\.(?:woff|ttf)\) format\("[^"]+"\)/g, "");

    for (const [font, replacement] of replacements) {
        css = css.replaceAll(`url(fonts/${font})`, replacement);
    }

    return `${highlight}\n${css}`;
}

export async function offlineShareAssets(hasMermaid: boolean): Promise<OfflineShareAssets> {
    cssPromise ??= offlineCss().catch((error: unknown) => {
        cssPromise = undefined;
        throw error;
    });
    if (hasMermaid) {
        mermaidPromise ??= readFile(
            new URL(
                "../../../macos/GenesisKit/Sources/GenesisKit/Markdown/Resources/webview/mermaid.min.js",
                import.meta.url
            ),
            "utf8"
        ).catch((error: unknown) => {
            mermaidPromise = undefined;
            throw error;
        });
    }
    const [css, mermaid] = await Promise.all([cssPromise, hasMermaid ? mermaidPromise : undefined]);
    return { css, mermaid };
}
