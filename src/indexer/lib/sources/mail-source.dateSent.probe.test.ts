import { Database } from "bun:sqlite";
import { describe, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pick the active Mail.app envelope index, or return null if none exists.
 * Mail.app stores its database under `~/Library/Mail/V<N>/MailData/Envelope Index`
 * where the version dir bumps with macOS releases (V10, V11, …). Resolve at
 * runtime so the probe stays useful across upgrades.
 */
function findEnvelopePath(): string | null {
    const override = process.env.MAIL_ENVELOPE_PATH;
    if (override && existsSync(override)) {
        return override;
    }

    const mailRoot = join(homedir(), "Library/Mail");
    if (!existsSync(mailRoot)) {
        return null;
    }

    try {
        const versions = readdirSync(mailRoot)
            .filter((name) => /^V\d+$/.test(name))
            .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
        for (const v of versions) {
            const candidate = join(mailRoot, v, "MailData/Envelope Index");
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    } catch {
        return null;
    }

    return null;
}

describe("date_sent prune predicate (probe — skipped if files missing)", () => {
    const indexPath = join(homedir(), ".genesis-tools/indexer/macos-mail/index.db");
    const envPath = findEnvelopePath();

    const skip = !existsSync(indexPath) || envPath === null;

    it.skipIf(skip)("counts how many chunks each predicate matches", () => {
        const idx = new Database(indexPath, { readonly: true });
        // SQLite ATTACH expects a single-quoted string literal; double single
        // quotes to escape any apostrophes in the resolved envelope path.
        const attachUri = `file:${(envPath ?? "").replaceAll("'", "''")}?mode=ro`;
        try {
            idx.run(`ATTACH DATABASE '${attachUri}' AS mailapp`);

            const totalChunks = (idx.query("SELECT COUNT(*) AS n FROM macos_mail_content").get() as { n: number })
                .n;

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
            console.log({
                totalChunks,
                missingRowid,
                softDeleted,
                dateMismatchStrict,
                dateMismatchTolerant,
                sample,
            });
        } finally {
            idx.close();
        }
    });
});
