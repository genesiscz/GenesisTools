import { Database } from "bun:sqlite";
import { describe, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

describe("date_sent prune predicate (probe — skipped if files missing)", () => {
    const indexPath = join(homedir(), ".genesis-tools/indexer/macos-mail/index.db");
    const envPath = join(homedir(), "Library/Mail/V10/MailData/Envelope Index");

    const skip = !existsSync(indexPath) || !existsSync(envPath);

    it.skipIf(skip)("counts how many chunks each predicate matches", () => {
        const idx = new Database(indexPath, { readonly: true });
        idx.run(`ATTACH DATABASE 'file:${envPath}?mode=ro' AS mailapp`);

        const totalChunks = (idx.query("SELECT COUNT(*) AS n FROM macos_mail_content").get() as { n: number }).n;

        const missingRowid = (
            idx
                .query(
                    `SELECT COUNT(*) AS n FROM macos_mail_content c
                     LEFT JOIN mailapp.messages m ON m.ROWID = CAST(c.source_id AS INTEGER)
                     WHERE m.ROWID IS NULL`
                )
                .get() as { n: number }
        ).n;

        const softDeleted = (
            idx
                .query(
                    `SELECT COUNT(*) AS n FROM macos_mail_content c
                     JOIN mailapp.messages m ON m.ROWID = CAST(c.source_id AS INTEGER)
                     WHERE m.deleted = 1`
                )
                .get() as { n: number }
        ).n;

        const dateMismatchStrict = (
            idx
                .query(
                    `SELECT COUNT(*) AS n FROM macos_mail_content c
                     JOIN mailapp.messages m ON m.ROWID = CAST(c.source_id AS INTEGER)
                     WHERE m.deleted = 0
                       AND m.date_sent != CAST(json_extract(c.metadata_json, '$.dateSent') AS INTEGER)`
                )
                .get() as { n: number }
        ).n;

        const dateMismatchTolerant = (
            idx
                .query(
                    `SELECT COUNT(*) AS n FROM macos_mail_content c
                     JOIN mailapp.messages m ON m.ROWID = CAST(c.source_id AS INTEGER)
                     WHERE m.deleted = 0
                       AND ABS(CAST(m.date_sent AS INTEGER) - CAST(json_extract(c.metadata_json, '$.dateSent') AS INTEGER)) > 1`
                )
                .get() as { n: number }
        ).n;

        const sample = idx
            .query(
                `SELECT m.date_sent AS env, json_extract(c.metadata_json, '$.dateSent') AS idx_raw,
                        CAST(json_extract(c.metadata_json, '$.dateSent') AS INTEGER) AS idx_int,
                        typeof(m.date_sent) AS env_type, typeof(json_extract(c.metadata_json, '$.dateSent')) AS idx_type
                 FROM macos_mail_content c
                 JOIN mailapp.messages m ON m.ROWID = CAST(c.source_id AS INTEGER)
                 LIMIT 5`
            )
            .all();

        // biome-ignore lint: probe output is the deliverable
        console.log({ totalChunks, missingRowid, softDeleted, dateMismatchStrict, dateMismatchTolerant, sample });
    });
});
