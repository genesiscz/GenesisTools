import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { errorDiagnostic, failReply, okReply, type Reply } from "@genesiscz/utils/output/reply";
import { type LegacyHandoff, parityOf } from "@genesiscz/utils/work/legacy/shadow";
import { workDbPath } from "@genesiscz/utils/work/store/db";

export interface DoctorReport {
    parityChecked: boolean;
    handoffs: number;
    message: string;
}

interface ParitySource {
    handoffs(): LegacyHandoff[];
    close(): void;
}

export function checkWork(openLegacy?: () => ParitySource): Reply<DoctorReport> {
    const path = workDbPath();

    if (!existsSync(path)) {
        return okReply("doctor", {
            parityChecked: false,
            handoffs: 0,
            message: "The work store has not been created.",
        });
    }

    const db = new Database(path, { readonly: true });

    try {
        const integrity = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
        const corrupt = integrity.filter((row) => row.quick_check !== "ok");

        if (corrupt.length > 0) {
            return failReply(
                "doctor",
                corrupt.map((row) => errorDiagnostic("INTEGRITY", row.quick_check))
            );
        }

        if (openLegacy === undefined) {
            return okReply("doctor", {
                parityChecked: false,
                handoffs: 0,
                message: "Work store integrity check passed.",
            });
        }

        const source = openLegacy();

        try {
            const handoffs = source.handoffs();
            const differences = handoffs.flatMap((handoff) => parityOf(db, handoff));

            if (differences.length > 0) {
                return failReply(
                    "doctor",
                    differences.map((x) =>
                        errorDiagnostic("PARITY", `${x.handoff}${x.slot ? `:${x.slot}` : ""}: ${x.what}`)
                    )
                );
            }

            return okReply("doctor", {
                parityChecked: true,
                handoffs: handoffs.length,
                message: `parity: ${handoffs.length} handoffs, 0 differences`,
            });
        } finally {
            source.close();
        }
    } finally {
        db.close();
    }
}
