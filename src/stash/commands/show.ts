import { Database } from "bun:sqlite";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { StoreRepo } from "../lib/store-repo";
import { ui } from "../lib/ui";
import type { RegionRow, StashRow, VersionRow } from "../types";

const { log } = logger.scoped("stash:show");

export async function showCommand(opts: {
    name: string;
    version?: number;
    mode: "diff" | "meta" | "regions";
}): Promise<void> {
    log.debug({ opts }, "showCommand");
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);
        db.close();
        process.exit(1);
    }
    const v = opts.version
        ? db
              .query<VersionRow, [string, number]>("SELECT * FROM versions WHERE stash_id = ? AND version = ?")
              .get(stash.id, opts.version)
        : db
              .query<VersionRow, [string]>("SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1")
              .get(stash.id);
    if (!v) {
        ui.err("version not found");
        db.close();
        process.exit(1);
    }
    log.debug({ stashId: stash.id, version: v.version, mode: opts.mode }, "version resolved");

    // Count actual regions-table rows for accurate display (versions.region_count was set at save
    // time from `@stash:` marker count in the patch — that's a SEMANTIC marker count, NOT the
    // hunk count. Users find this confusing: they see "regions 0" alongside a 10-row inventory.
    // Show the table count, which matches what the inventory below renders.
    const regionRowCount = db
        .query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM regions WHERE version_id = ?")
        .get(v.id);
    const actualRegions = regionRowCount?.c ?? 0;

    // Pretty-print tags: stored as JSON array string; show as comma-separated list. Falls back to
    // "—" when missing OR when the stored value parses to an empty array. Defensive parse so a
    // corrupted tags column doesn't crash the show.
    let tagsDisplay = "—";
    if (stash.tags) {
        try {
            const arr = SafeJSON.parse(stash.tags) as unknown;
            if (Array.isArray(arr)) {
                tagsDisplay = arr.length > 0 ? arr.join(", ") : "—";
            } else {
                tagsDisplay = stash.tags;
            }
        } catch (err) {
            log.debug({ err, raw: stash.tags }, "tags parse failed; showing raw");
            tagsDisplay = stash.tags;
        }
    }

    ui.header(`${stash.name}  v${v.version}`);
    ui.kv("tags", tagsDisplay);
    ui.kv("desc", stash.description ?? "—");
    ui.kv("source", `${v.source_repo_path ?? "?"} @ ${v.source_sha?.slice(0, 7) ?? "?"}`);
    ui.kv("origin", v.source_origin ?? "—");
    ui.kv("files", String(v.file_count));
    ui.kv("regions", String(actualRegions));
    ui.kv("created", v.created_at);

    if (opts.mode === "meta") {
        db.close();
        return;
    }
    const repo = new StoreRepo(storage.storeRepoDir());
    if (opts.mode === "diff") {
        const patch = await repo.readFileAt(v.patch_ref, "PATCH.diff");
        ui.section("patch");
        // Patch body to stdout so `tools stash show <name> --diff > foo.patch` captures cleanly.
        out.print(patch ?? "(empty)");
    } else {
        const regions = db
            .query<RegionRow, [string]>("SELECT * FROM regions WHERE version_id = ? ORDER BY file_path, hunk_index")
            .all(v.id);
        ui.section(`regions (${regions.length})`);
        if (!regions.length) {
            ui.dim("  (none recorded — older versions before region tracking)");
        }
        const fileW = Math.max(4, ...regions.map((r) => r.file_path.length));
        for (const r of regions) {
            const name = r.region_name ?? "(anon)";
            // `ui.raw` (stderr, newline-terminated) so the rows ORDER correctly relative to the
            // header above and don't get interleaved with stderr metadata due to stdout buffering
            // (previously used `out.print` which is unterminated AND stdout — caused rows to
            // mash onto one line AND appear before the header in interactive use).
            ui.raw(
                `  ${r.file_path.padEnd(fileW)}  hunk ${r.hunk_index}  ${String(r.line_count).padStart(4)} lines  ${name}`
            );
        }
    }
    db.close();
}
