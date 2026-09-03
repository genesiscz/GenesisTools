import { SafeJSON } from "@genesiscz/utils/json";
import type {
    CloneRenderer,
    DuplicatesReport,
    MeasureReport,
    PlanReport,
    ProcessListReport,
    ProcessReport,
} from "./types";

export class JsonRenderer implements CloneRenderer {
    measure(r: MeasureReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    duplicates(r: DuplicatesReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    plan(r: PlanReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    /** `plan --format jsonl`: the whole plan on one line. */
    planJsonl(r: PlanReport): string {
        return SafeJSON.stringify(r);
    }

    processReport(r: ProcessReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    processList(r: ProcessListReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    /** `--log --format jsonl`: one ProcessOp object per line (raw stream). */
    processReportJsonl(r: ProcessReport): string {
        return r.ops.map((op) => SafeJSON.stringify(op)).join("\n");
    }
}
