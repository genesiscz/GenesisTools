/** scaffold / cheatsheet / mcp — the scripting doors. */
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { findRecipe, recipeHelpLines, scaffoldRecipeScript } from "../lib/scaffold.ts";
import { resolvePort, suggest, withPort } from "./shared.ts";

const CHEATSHEET_PATH = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "plugins",
    "genesis-tools",
    "skills",
    "chrome-devtools",
    "references",
    "cdp-cheatsheet.md"
);

export function registerScripting(program: Command): void {
    program
        .command("scaffold")
        .description(
            "create a CDP scratch script in the `tools scripts` store (versioned, listable, runnable there) from a probed recipe"
        )
        .argument("[name]", "script name (letters, digits, dash, underscore)")
        .option("--recipe <recipe>", "which recipe to start from (see --list)")
        .option("--list", "list the recipes and exit")
        .addHelpText(
            "after",
            `
Recipes (each verified against a live CDP browser before shipping):
${recipeHelpLines().join("\n")}

Examples:
  ${suggest(["scaffold", "colRedirects", "--recipe", "redirect-chain"])}
  tools scripts run colRedirects -- --port 9222 --match idp.example.com
  tools scripts show colRedirects`
        )
        .action(async (name: string | undefined, opts: { recipe?: string; list?: boolean }) => {
            if (opts.list || !name) {
                if (!name && !opts.list) {
                    out.log.error("scaffold needs a script name.");
                    out.log.info(`  e.g. ${suggest(["scaffold", "myProbe", "--recipe", "redirect-chain"])}`);
                }

                out.println("Recipes:");
                out.println(recipeHelpLines().join("\n"));
                process.exit(opts.list ? 0 : 1);
            }

            const recipeName = opts.recipe ?? "blank";
            const recipe = findRecipe(recipeName);
            if (!recipe) {
                out.log.error(`unknown recipe '${recipeName}'. Available:`);
                out.log.error(recipeHelpLines().join("\n"));
                process.exit(1);
            }

            const result = await scaffoldRecipeScript({ name, recipe });
            out.log.success(`created ${result.file}`);
            out.log.info(`  run:  ${result.runHint}`);
            out.log.info(`  edit: it is yours — tools scripts show ${name}`);
            process.exit(0);
        });

    program
        .command("cheatsheet")
        .description("print the CDP scripting cheatsheet (lib API, recipes, channels, do-not-pipe rules)")
        .action(async () => {
            const file = Bun.file(CHEATSHEET_PATH);
            if (!(await file.exists())) {
                out.log.error(`cheatsheet missing at ${CHEATSHEET_PATH} — the plugin skill directory moved?`);
                process.exit(1);
            }

            out.println(await file.text());
            process.exit(0);
        });

    withPort(program.command("mcp"))
        .description("call the real chrome-devtools-mcp tools against this port (no session config edit, no restart)")
        .argument("[tool]", "tool name, or 'list'", "list")
        .argument("[json]", "arguments as JSON", "{}")
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["mcp", "list"])}
  ${suggest(["mcp", "navigate_page", '{"url":"https://example.com"}'])}
  ${suggest(["mcp", "take_snapshot"])}`
        )
        .action(async (tool: string, json: string, opts: { port?: string }) => {
            const { callTool, listTools } = await import("../lib/mcp.ts");
            const port = await resolvePort(opts);

            if (!tool || tool === "list") {
                out.println((await listTools({ port })).join("\n"));
                process.exit(0);
            }

            let args: unknown;
            try {
                args = SafeJSON.parse(json, { strict: true });
            } catch {
                out.log.error(`arguments are not valid JSON: ${json}`);
                out.log.info(`  e.g. ${suggest(["mcp", tool, '{"url":"https://example.com"}'])}`);
                process.exit(1);
            }

            if (typeof args !== "object" || args === null || Array.isArray(args)) {
                out.log.error(`arguments must be a JSON object, got: ${json}`);
                out.log.info(`  e.g. ${suggest(["mcp", tool, '{"url":"https://example.com"}'])}`);
                process.exit(1);
            }

            const result = await callTool(tool, args as Record<string, unknown>, { port });
            out.println(SafeJSON.stringify(result, { strict: true }, 1).slice(0, 4000));
            process.exit(0);
        });
}
