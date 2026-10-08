import { fileURLToPath } from "node:url";
import { wowTheme } from "@genesiscz/utils/ui/theme/themes";
import { readModelDocument } from "./document";
import { evaluateDocument } from "./evaluation";
import { scriptJSON } from "./exports";

export async function standaloneModelHTML(input: unknown): Promise<string> {
    const document = readModelDocument(input);
    const evaluation = await evaluateDocument({ input: document });
    const invalid = evaluation.scenarios.find((scenario) => scenario.error);

    if (invalid) {
        throw new Error(`Fix the scenario “${invalid.label}” before exporting: ${invalid.error}`);
    }

    const build = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../browser/presentation.ts", import.meta.url))],
        target: "browser",
        format: "iife",
        minify: true,
        sourcemap: "none",
        splitting: false,
    });

    if (!build.success || build.outputs.length !== 1) {
        throw new Error(`Could not bundle the offline model: ${build.logs.map(String).join("\n")}`);
    }

    const script = (await build.outputs[0].text()).replaceAll("</script", "<\\/script");
    const colors = wowTheme.colors;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Model Room · Interactive model</title><style>
:root{color-scheme:dark;--background:${colors.bg.primary};--foreground:${colors.text.primary};--card:${colors.bg.card};--muted:${colors.bg.elevated};--muted-foreground:${colors.text.secondary};--border:${colors.border.light};--primary:${colors.accent.violetLight};--destructive:${colors.accent.rose}}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:15px/1.5 system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:36px 24px}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:24px}h1{font-size:32px;letter-spacing:-.035em;margin:4px 0}h2{font-size:18px;margin:0 0 12px}p{color:var(--muted-foreground);max-width:76ch}.caption,small{color:var(--muted-foreground);font-size:12px}button,select,input{font:inherit}button,select{border:1px solid var(--border);border-radius:8px;padding:8px 12px;background:var(--card);color:var(--foreground);cursor:pointer}button:hover,select:hover{border-color:var(--primary);background:var(--muted)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:3px}.primary{background:var(--primary);color:var(--background);font-weight:650}.toolbar{display:flex;gap:8px;flex-wrap:wrap}.layout{display:grid;grid-template-columns:290px 1fr;gap:22px;margin-top:24px}section,aside{border:1px solid var(--border);border-radius:14px;padding:22px;background:var(--card);box-shadow:${wowTheme.shadows.card}}label{display:block;margin:16px 0 6px;font-size:13px}input[type=range]{width:100%;accent-color:var(--primary)}input[type=number]{width:100%;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:6px;padding:7px}.value{font-variant-numeric:tabular-nums;font-weight:650}.error{color:var(--destructive)}svg{width:100%;height:auto;min-height:240px;overflow:visible}.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;margin-bottom:16px}.stat{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:9px 0}.narrative{border-left:3px solid var(--primary);padding-left:16px;margin:24px 0}details{margin-top:24px}summary{cursor:pointer;color:var(--primary)}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid var(--border);padding:8px}.scroll{overflow:auto}footer{margin:24px 0;color:var(--muted-foreground);font-size:12px}@media(max-width:760px){.layout{grid-template-columns:1fr}header{display:block}.toolbar{margin-top:16px}main{padding:20px 14px}}
</style></head><body><main id="app"></main><script type="application/json" id="model-document">${scriptJSON(document)}</script><script>${script}</script></body></html>`;
}
