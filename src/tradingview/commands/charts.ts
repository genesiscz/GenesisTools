import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";
import { resolveSession } from "../lib/auth";
import { getLayoutStudies, listLayouts } from "../lib/charts-storage";
import { formatLayoutRow } from "../lib/format";

export interface ChartsOpts {
    cookie?: string;
}

export async function runCharts(layoutId: string | undefined, opts: ChartsOpts): Promise<void> {
    const session = await resolveSession({ cookie: opts.cookie });
    if (!session) {
        out.error(
            "No TradingView session found. Configure TRADINGVIEW_COOKIE or ~/.genesis-tools/tradingview/config.json."
        );
        process.exit(1);
    }

    if (!layoutId) {
        const layouts = await listLayouts(session);
        out.printlnErr(pc.bold(`\n${layouts.length} saved layout(s):\n`));
        for (const layout of layouts) {
            out.printlnErr(formatLayoutRow(layout));
        }
        return;
    }

    const studies = await getLayoutStudies(session, layoutId);
    if (studies.length === 0) {
        out.warn(`Layout ${layoutId} has no attachable studies.`);
        return;
    }

    out.printlnErr(pc.bold(`\n${studies.length} study/studies on ${layoutId}:\n`));
    for (const study of studies) {
        out.printlnErr(pc.cyan(study.name));
        if (study.pineId) {
            out.printlnErr(pc.dim(`  pineId: ${study.pineId}${study.pineVersion ? ` @ ${study.pineVersion}` : ""}`));
        }

        const inputKeys = Object.keys(study.inputs);
        if (inputKeys.length > 0) {
            out.printlnErr(pc.dim("  inputs:"));
            for (const key of inputKeys.sort()) {
                out.printlnErr(pc.dim(`    ${key}=${SafeJSONLine(study.inputs[key])}`));
            }
        } else {
            out.printlnErr(pc.dim("  inputs: (defaults)"));
        }

        out.printlnErr("");
    }
}

function SafeJSONLine(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    return SafeJSON.stringify(value, { strict: true }) ?? String(value);
}
