import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { build } from "vite";
import { pinNodeModules } from "./pin-node-modules";

function writeTree(root: string, files: Record<string, string>): void {
    for (const [relative, content] of Object.entries(files)) {
        const file = join(root, relative);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
}

function manifest(name: string): string {
    return SafeJSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }, { strict: true });
}

async function bundle(root: string): Promise<string> {
    const result = await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [pinNodeModules(root)],
        build: { write: false, minify: false, lib: { entry: "index.js", formats: ["es"], fileName: "out" } },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!("output" in output)) {
        throw new Error("vite build returned a watcher, expected a bundle");
    }

    return output.output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
}

function tempRoot(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "pin-node-modules-")));
}

describe("pinNodeModules", () => {
    it("lets a dependency use its own nested copy of a package instead of the hoisted one", async () => {
        const root = tempRoot();
        writeTree(root, {
            "index.js": `import { which } from "lib";\nconsole.log(which());\n`,
            "node_modules/lib/package.json": manifest("lib"),
            "node_modules/lib/index.js": `import { version } from "redux";\nexport const which = () => version;\n`,
            "node_modules/redux/package.json": manifest("redux"),
            "node_modules/redux/index.js": `export const version = "hoisted-4";\n`,
            "node_modules/lib/node_modules/redux/package.json": manifest("redux"),
            "node_modules/lib/node_modules/redux/index.js": `export const version = "nested-5";\n`,
        });

        const code = await bundle(root);

        expect(code).toContain("nested-5");
        expect(code).not.toContain("hoisted-4");
    });

    it("still pins a dependency without a nested copy to the dashboard's tree", async () => {
        const base = tempRoot();
        writeTree(base, {
            "wt/ui/index.js": `import { which } from "../../main/node_modules/lib/index.js";\nconsole.log(which());\n`,
            "main/node_modules/lib/package.json": manifest("lib"),
            "main/node_modules/lib/index.js": `import { id } from "react";\nexport const which = () => id;\n`,
            "main/node_modules/react/package.json": manifest("react"),
            "main/node_modules/react/index.js": `export const id = "main-react";\n`,
            "wt/node_modules/react/package.json": manifest("react"),
            "wt/node_modules/react/index.js": `export const id = "wt-react";\n`,
        });

        const code = await bundle(join(base, "wt/ui"));

        expect(code).toContain("wt-react");
        expect(code).not.toContain("main-react");
    });
});
