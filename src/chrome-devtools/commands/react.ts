/** react find — locate live objects (a QueryClient, a store) in a page's React tree by the props that carry them. */
import { findReactProps } from "@genesiscz/utils/chrome-devtools/libraries/react/find-props";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { cdpLikeOf } from "../lib/cdp-like-adapter.ts";
import { reactMatchersFrom } from "../lib/inspect-data.ts";
import { attachTab, suggest, withPage } from "./shared.ts";

const { log } = logger.scoped("chrome-devtools:react");

type FindOptions = {
    port?: string;
    match?: string;
    function: string[];
    path: string[];
    component?: string;
    expose?: string;
    json?: boolean;
};

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export function registerReact(program: Command): void {
    const react = program.command("react").description("look inside a page's React tree");

    withPage(react.command("find"))
        .description(
            "find the components whose props carry a function or value, e.g. the TanStack QueryClient or the Redux store, in one walk of every React root"
        )
        .option(
            "--function <propPath>",
            "a dotted props path that must be a function; its owner is the match (repeatable)",
            collect,
            []
        )
        .option(
            "--path <propPath>",
            "a dotted props path that must hold a value; that value is the match (repeatable)",
            collect,
            []
        )
        .option("--component <name>", "only components with exactly this name; alone, it matches their props")
        .option(
            "--expose <windowSlot>",
            "put the live match on window[<windowSlot>] for later 'eval' calls (one matcher only)"
        )
        .option("--json", "the full result as JSON on stdout")
        .addHelpText(
            "after",
            `
Use it to reach app state that has no global: find the provider that holds it, then --expose it
and read it with 'eval'. No eval or new Function in the page, so it works under a strict CSP.
Read-only unless --expose, which sets that one window property. Exit code 1 when a matcher found nothing.

Examples:
  ${suggest(["react", "find", "--match", "localhost:3000", "--function", "client.getQueryCache", "--function", "store.getState"])}
  ${suggest(["react", "find", "--match", "app.example.com", "--function", "client.getQueryCache", "--expose", "__qc"])}
    then: ${suggest(["eval", "--match", "app.example.com", "() => window.__qc.getQueryCache().getAll().length"])}
  ${suggest(["react", "find", "--match", "app.example.com", "--component", "ThemeProvider", "--json"])}`
        )
        .action(async (opts: FindOptions) => {
            const matchers = reactMatchersFrom({
                functions: opts.function,
                paths: opts.path,
                component: opts.component,
                expose: opts.expose,
            });

            if ("error" in matchers) {
                out.log.error(matchers.error);
                out.log.info(
                    `  ${suggest(["react", "find", "--match", opts.match ?? "<tab>", "--function", "client.getQueryCache"])}`
                );
                process.exit(1);
            }

            const page = await attachTab(opts);
            out.log.info(`attached to: ${page.target.url}`);
            const result = await findReactProps(cdpLikeOf(page), { matchers });
            page.close();
            log.debug(
                { roots: result.roots, fibers: result.fibers, matches: result.matches.length, missing: result.missing },
                "react find"
            );

            if (opts.json) {
                out.result(result);
                process.exit(result.error || result.missing.length > 0 ? 1 : 0);
            }

            if (result.error) {
                out.log.error(result.error);
                process.exit(1);
            }

            renderCliHeader(
                "React props",
                `${result.roots} root(s) · ${result.fibers}${result.truncated ? "+" : ""} fibers`
            );

            if (result.roots === 0) {
                out.log.warn("no React root found on this page (or React has not rendered yet).");
            }

            if (result.truncated) {
                out.log.warn(`the walk stopped at ${result.fibers} fibers, so a 'missing' matcher may sit deeper.`);
            }

            if (result.matches.length > 0) {
                const table = createBoxTable(["MATCHER", "COMPONENT", "DEPTH", "PROP PATH", "ANCESTORS"]);
                for (const match of result.matches) {
                    table.push([
                        pc.white(match.matcher),
                        match.component,
                        String(match.depth),
                        match.propPath || pc.dim("(props)"),
                        truncateDisplay(match.ancestors.slice(0, 4).join(" < "), 60),
                    ]);
                }

                out.println(table.toString());
            }

            for (const match of result.matches.filter((entry) => entry.exposedAs)) {
                out.log.info(
                    `exposed ${match.matcher} as window.${match.exposedAs}: ${suggest(["eval", "--match", opts.match ?? "<tab>", `() => Object.keys(window.${match.exposedAs})`])}`
                );
            }

            if (result.missing.length > 0) {
                out.log.warn(`missing: ${result.missing.join(", ")}`);
                process.exit(1);
            }

            process.exit(0);
        });
}
