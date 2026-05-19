import { SafeJSON } from "@app/utils/json";
import type {
    CloneRenderer,
    DuplicatesReport,
    MeasureReport,
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
