import type { Analyzer } from "@app/doctor/lib/analyzer";
import { isInteractive } from "@genesiscz/utils/cli";
import * as p from "@genesiscz/utils/prompts/p";

export interface PickerOpts {
    available: Analyzer[];
    defaults?: string[];
    only?: string[];
}

export async function pickAnalyzers(opts: PickerOpts): Promise<Analyzer[]> {
    if (opts.only && opts.only.length > 0) {
        const allow = new Set(opts.only);
        return opts.available.filter((analyzer) => allow.has(analyzer.id));
    }

    const defaultIds = new Set(opts.defaults ?? opts.available.map((analyzer) => analyzer.id));

    if (!isInteractive()) {
        // No terminal: the defaults run as the picker would have preselected them. The findings step
        // acts on nothing without a terminal either (findings.ts), so the run only reports.
        const chosen = opts.available.filter((analyzer) => defaultIds.has(analyzer.id));
        p.log.info(`No terminal: running the default analyzers (${chosen.map((analyzer) => analyzer.id).join(", ")}).`);
        return chosen;
    }

    const picked = await p.multiselect({
        message: "Which analyzers to run?",
        options: opts.available.map((analyzer) => ({
            value: analyzer.id,
            label: `${analyzer.icon}  ${analyzer.name}`,
        })),
        initialValues: opts.available.filter((analyzer) => defaultIds.has(analyzer.id)).map((analyzer) => analyzer.id),
        required: true,
    });

    const pickedSet = new Set(picked);
    return opts.available.filter((analyzer) => pickedSet.has(analyzer.id));
}
