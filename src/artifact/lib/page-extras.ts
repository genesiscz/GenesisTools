import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MERMAID_FENCE_CLASS } from "./markdown";
import { RUNTIME_DIR } from "./vite";

/**
 * What a served or built .md page needs beyond TITLE/CONTENT/THEME so it
 * matches the kit: the highlight token CSS, and the mermaid hydrator when the
 * body has a fence to hydrate. The hydrator is the kit's own mermaid-core.ts,
 * transpiled here, so the two doors run one implementation.
 */
export interface MdPageExtras {
    CODE_CSS: string;
    SCRIPTS: string;
}

interface Loaded {
    codeCss: string;
    mermaidScript: string;
}

let loaded: Loaded | null = null;

function load(): Loaded {
    if (loaded) {
        return loaded;
    }

    const codeCss = readFileSync(join(RUNTIME_DIR, "code-theme.css"), "utf8");
    const source = readFileSync(join(RUNTIME_DIR, "kit", "mermaid-core.ts"), "utf8");
    const js = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);

    if (js.includes("</script")) {
        throw new Error("mermaid-core.ts contains '</script', which would end the inline page script early");
    }

    loaded = {
        codeCss,
        mermaidScript: `<script type="module">\n${js}\nhydrateMermaidFences(document);\n</script>`,
    };

    return loaded;
}

export function mdPageExtras(renderedHtml: string): MdPageExtras {
    const { codeCss, mermaidScript } = load();

    return {
        CODE_CSS: codeCss,
        SCRIPTS: renderedHtml.includes(`class="${MERMAID_FENCE_CLASS}"`) ? mermaidScript : "",
    };
}
