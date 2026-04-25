import type { Analyzer } from "@app/doctor/lib/analyzer";
import * as p from "@app/utils/prompts/p";

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
