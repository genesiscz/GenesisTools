import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { compactResult } from "../output-shape";
import type { CustomTemplate } from "./custom";
import type { GateVerdict } from "./gate";
import { type SarifSubject, toSarif } from "./sarif";
import type { PurposeTemplate } from "./templates";

export const GATE_EXIT_CODE = 2;

/**
 * The one output path both verbs use, so `--sarif`, `--gate` and `--json` behave identically on
 * `screen` and on `verify`.
 *
 * SARIF goes out raw through `out.print`; everything else goes through `out.result`, stripped of
 * the raw evaluation payload unless `--json` asked for it. Gate reasons are human status lines on
 * stderr, so piping the result to a file still yields parseable output.
 */
export function emitReport(options: {
    result: unknown;
    gate: GateVerdict;
    subjects: SarifSubject[];
    purposes: PurposeTemplate[];
    custom?: CustomTemplate[];
    sarif?: boolean;
    gateEnabled?: boolean;
    json?: boolean;
}): void {
    if (options.sarif) {
        const log = toSarif({ subjects: options.subjects, purposes: options.purposes, custom: options.custom });
        out.print(`${SafeJSON.stringify(log, null, 2)}\n`);
    } else {
        out.result(compactResult(options.result, { verbose: options.json }));
    }

    for (const reason of options.gate.reasons) {
        const where = reason.file ? `${reason.file}: ` : "";
        ui.warn(`${where}gate ${reason.id} fired at ${reason.score} (threshold ${reason.threshold})`);
    }

    if (options.gate.block && options.gateEnabled) {
        logger.warn({ reasons: options.gate.reasons.map((reason) => reason.id) }, "Jev gate blocked; exiting 2");
        ui.err(`Gate blocked on: ${options.gate.reasons.map((reason) => reason.id).join(", ")}`);
        process.exitCode = GATE_EXIT_CODE;
    }
}
