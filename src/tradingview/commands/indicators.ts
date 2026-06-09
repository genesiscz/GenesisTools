import { out } from "@app/logger";
import pc from "picocolors";
import { resolveSession } from "../lib/auth";
import { fetchStandardList } from "../lib/indicator-aliases";
import { type IndicatorFilter, listIndicators } from "../lib/pine-facade";

export interface IndicatorsOpts {
    filter?: IndicatorFilter;
    cookie?: string;
}

export async function runIndicators(query: string | undefined, opts: IndicatorsOpts): Promise<void> {
    const filter = opts.filter ?? "standard";
    let scripts =
        filter === "standard"
            ? await fetchStandardList()
            : await listIndicators({
                  filter,
                  cookie: (await resolveSession({ cookie: opts.cookie }))?.cookie,
              });

    if (filter !== "standard" && scripts.length === 0) {
        const session = await resolveSession({ cookie: opts.cookie });
        if (!session) {
            out.error(`--filter ${filter} requires a TradingView session cookie.`);
            process.exit(1);
        }

        scripts = await listIndicators({ filter, cookie: session.cookie });
    }

    if (query) {
        const q = query.trim().toLowerCase();
        scripts = scripts.filter(
            (script) => script.scriptName.toLowerCase().includes(q) || script.scriptIdPart.toLowerCase().includes(q)
        );
    }

    out.printlnErr(pc.bold(`\n${scripts.length} indicator(s) [${filter}]:\n`));
    for (const script of scripts) {
        out.printlnErr(
            `${pc.dim(script.scriptIdPart.padEnd(42))}  ${script.scriptName.padEnd(36)}  ${pc.dim(script.version)}`
        );
    }
}
