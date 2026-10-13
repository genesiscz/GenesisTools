/** storage idb / storage web — read a tab's IndexedDB and Web Storage, or the IndexedDB of a profile with no debug port. */
import { homedir } from "node:os";
import { join } from "node:path";
import {
    dumpIndexedDb,
    dumpWebStorage,
    type IdbDump,
    type IdbDumpArgs,
    type WebStorageDump,
} from "@genesiscz/utils/chrome-devtools/storage";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { cdpLikeOf } from "../lib/cdp-like-adapter.ts";
import { biggestIdbRows, idbStoreLines, parseIdbKey } from "../lib/inspect-data.ts";
import { artifactPath } from "../lib/platform.ts";
import { readProfileIndexedDb } from "../lib/profile-idb.ts";
import { isPortSpecified } from "../lib/resolve-attach.ts";
import { attachTab, positiveNumber, suggest, withPage } from "./shared.ts";

const { log } = logger.scoped("chrome-devtools:storage");

const BIGGEST_ROWS = 5;

type IdbOptions = {
    port?: string;
    match?: string;
    db?: string;
    store?: string;
    key?: string;
    maxValueBytes?: string;
    keysOnly?: boolean;
    json?: boolean;
    out?: string;
    fromProfile?: string;
    origin?: string;
    browser: string;
};

type WebOptions = { port?: string; match?: string; keys?: string; json?: boolean; out?: string };

function keyLabel(key: unknown): string {
    return typeof key === "string" ? key : SafeJSON.stringify(key);
}

function printIdbTables(dump: IdbDump, onDiskBytes: number | null): void {
    const lines = idbStoreLines(dump);
    const total = lines.reduce((sum, line) => sum + (line.bytes ?? 0), 0);
    const sized = lines.some((line) => line.bytes !== null);
    renderCliHeader("IndexedDB", dump.origin);

    if (dump.error) {
        out.log.warn(dump.error);
    }

    if (lines.length === 0) {
        out.println(pc.dim("  no IndexedDB databases on this origin"));
        return;
    }

    const table = createBoxTable(["DB", "STORE", "ROWS", "DATA BYTES"]);
    for (const line of lines) {
        table.push([
            pc.white(line.db),
            line.store ?? pc.red(`(not opened) ${line.error ?? ""}`),
            String(line.rows),
            line.bytes === null ? "—" : formatBytes(line.bytes),
        ]);
    }

    out.println(table.toString());
    out.println(
        pc.dim(
            `  ${dump.databases.length} database(s) · ${lines.filter((line) => line.store !== null).length} store(s)${sized ? ` · ${formatBytes(total)} of data` : ""}`
        )
    );

    for (const line of lines.filter((entry) => entry.store !== null && entry.error)) {
        out.log.warn(`${line.db}/${line.store}: ${line.error}`);
    }

    const biggest = biggestIdbRows(dump, BIGGEST_ROWS);
    if (biggest.length > 0) {
        renderCliSection(`Biggest ${biggest.length} row(s)`);
        const rows = createBoxTable(["DB", "STORE", "KEY", "DATA BYTES", "VALUE STARTS"]);
        for (const row of biggest) {
            rows.push([
                row.db,
                row.store,
                truncateDisplay(keyLabel(row.key), 40),
                formatBytes(row.bytes),
                truncateDisplay(row.preview, 40),
            ]);
        }

        out.println(rows.toString());
    }

    if (onDiskBytes !== null) {
        out.println(
            pc.dim(
                `  on disk: ${formatBytes(onDiskBytes)} of leveldb files · data: ${sized ? formatBytes(total) : "?"}. The folder size is not the data size.`
            )
        );
    }
}

function printWebStorage(dump: WebStorageDump): void {
    renderCliHeader("Web Storage", dump.origin);

    const table = createBoxTable(["AREA", "KEY", "CHARS", "VALUE STARTS"]);
    for (const [area, content] of [
        ["local", dump.local],
        ["session", dump.session],
    ] as const) {
        if (content.error) {
            out.log.warn(`${area}Storage: ${content.error}`);
        }

        for (const entry of content.entries) {
            table.push([
                area,
                pc.white(truncateDisplay(entry.key, 40)),
                String(entry.chars),
                truncateDisplay(entry.value ?? entry.preview, 48),
            ]);
        }
    }

    if (dump.local.entries.length + dump.session.entries.length === 0) {
        out.println(pc.dim("  localStorage and sessionStorage are empty on this origin"));
        return;
    }

    out.println(table.toString());
    out.println(
        pc.dim(
            `  local: ${dump.local.entries.length} key(s), ${dump.local.chars} chars · session: ${dump.session.entries.length} key(s), ${dump.session.chars} chars`
        )
    );
}

async function writeOut(path: string, value: unknown): Promise<void> {
    await Bun.write(path, `${SafeJSON.stringify(value, null, 2)}\n`);
    out.log.info(`full dump -> ${path}`);
}

function idbArgs(opts: IdbOptions, humanOnly: boolean): IdbDumpArgs {
    const args: IdbDumpArgs = {};

    if (opts.db) {
        args.db = opts.db;
    }

    if (opts.store) {
        args.store = opts.store;
    }

    if (opts.key !== undefined) {
        args.key = parseIdbKey(opts.key);
    }

    if (opts.keysOnly) {
        args.keysOnly = true;
    }

    if (opts.maxValueBytes !== undefined) {
        args.maxValueBytes = positiveNumber(opts.maxValueBytes, 0, "--max-value-bytes");
    } else if (humanOnly) {
        // The tables show sizes and a 40-character preview, never whole values. A cap of 0 keeps the
        // byte counts (measured in the page) and sends only a 200-character preview per row.
        args.maxValueBytes = 0;
    }

    return args;
}

async function runIdbFromProfile(opts: IdbOptions & { fromProfile: string }): Promise<void> {
    if (!opts.origin) {
        out.log.error("--from-profile needs --origin: the profile holds every site's IndexedDB.");
        out.log.info(
            `  ${suggest(["storage", "idb", "--from-profile", opts.fromProfile, "--origin", "https://app.example.com"])}`
        );
        process.exit(1);
    }

    if (opts.match || isPortSpecified()) {
        out.log.error(
            "--from-profile reads a COPY in its own headless browser, so --match and --port have no tab to pick."
        );
        process.exit(1);
    }

    // A quoted "~/Library/..." reaches us unexpanded; the shell only expands a bare tilde.
    const profileDir = opts.fromProfile.startsWith("~/")
        ? join(homedir(), opts.fromProfile.slice(2))
        : opts.fromProfile;
    const humanOnly = !opts.json && !opts.out;
    try {
        const read = await readProfileIndexedDb({
            profileDir,
            origin: opts.origin,
            browser: opts.browser,
            args: idbArgs(opts, humanOnly),
            onStep: (message) => out.log.info(message),
        });
        out.log.info(`scratch copy kept at ${read.userDataDir} (the source profile was only read)`);

        if (opts.out) {
            await writeOut(opts.out, read.dump);
        }

        if (opts.json) {
            out.result(read.dump);
        } else {
            printIdbTables(read.dump, read.copy.onDiskBytes);
        }
    } catch (err) {
        log.debug({ err, profileDir, origin: opts.origin }, "profile IndexedDB read failed");
        out.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    process.exit(0);
}

export function registerStorage(program: Command): void {
    const storage = program
        .command("storage")
        .description("read a site's IndexedDB, localStorage and sessionStorage (read-only)");

    withPage(storage.command("idb"))
        .description(
            "dump the IndexedDB of the picked tab's origin, read-only; or, with --from-profile, of a browser that runs without a debug port"
        )
        .option("--db <name>", "only this database (a name that does not exist is reported, never created)")
        .option("--store <name>", "only this object store")
        .option("--key <key>", 'only this row; digits are a number key, "42" in double quotes a string key')
        .option("--max-value-bytes <n>", "replace values whose JSON is bigger than this with a 200-character preview")
        .option("--keys-only", "keys and row counts only, no values and no sizes")
        .option("--json", "the whole dump as JSON on stdout")
        .option(
            "-o, --out <file>",
            "write the whole dump as JSON to this file (values uncapped unless --max-value-bytes)"
        )
        .option(
            "--from-profile <profileDir>",
            "copy this profile's IndexedDB for --origin and read the copy in a headless browser"
        )
        .option("--origin <url>", "with --from-profile: the site whose IndexedDB to read")
        .option("--browser <id>", "with --from-profile: the headless browser that reads the copy", "chrome")
        .addHelpText(
            "after",
            `
Use it to see what a web app keeps offline: cached queries, drafts, sync queues, and how big they are.
The table lists every store with its row count and its data size (a string counts its own text, any other
value its JSON; --json also carries jsonBytes, which counts quotes and escapes), then the 5 biggest rows.

The trap: the leveldb folder size on disk is NOT the data size, in either direction. Measured: a
2.4 MB folder held 370 KB of rows (leveldb appends a full copy of every write to its log), and a
19.7 KB folder held 360 KB (leveldb compresses). Read the DATA BYTES column, not 'du'.

--from-profile reads a browser that was started WITHOUT a debug port, without restarting it: the
origin's IndexedDB folders are copied into a scratch user-data-dir (path printed, kept, the source is
only read), a headless browser opens the copy on a free port, every request to the origin gets a
blank page (no app code runs, no network), and the dump comes from there. Profile folders on macOS:
  Brave   ~/Library/Application Support/BraveSoftware/Brave-Browser/Default   (or Profile 1, ...)
  Chrome  ~/Library/Application Support/Google/Chrome/Default
When the copy does not open (written by a newer Chromium than the headless one), pass --browser brave
to read a Brave profile with Brave itself.

Examples:
  ${suggest(["storage", "idb", "--match", "app.example.com"])}
  ${suggest(["storage", "idb", "--match", "localhost:3000", "--db", "app-db", "--store", "queries", "--key", "user:42", "--json"])}
  ${suggest(["storage", "idb", "--match", "app.example.com", "-o", artifactPath("idb.json")])}
  ${suggest(["storage", "idb", "--from-profile", "~/Library/Application Support/BraveSoftware/Brave-Browser/Default", "--origin", "https://app.example.com", "--browser", "brave"])}`
        )
        .action(async (opts: IdbOptions) => {
            if (opts.fromProfile) {
                await runIdbFromProfile({ ...opts, fromProfile: opts.fromProfile });
                return;
            }

            if (opts.origin) {
                out.log.error("--origin only applies with --from-profile. A live tab is picked with --match.");
                out.log.info(`  ${suggest(["storage", "idb", "--match", opts.origin])}`);
                process.exit(1);
            }

            const humanOnly = !opts.json && !opts.out;
            const page = await attachTab(opts);
            out.log.info(`attached to: ${page.target.url}`);
            const dump = await dumpIndexedDb(cdpLikeOf(page), idbArgs(opts, humanOnly));
            page.close();
            log.debug({ origin: dump.origin, databases: dump.databases.length }, "IndexedDB dumped");

            if (opts.out) {
                await writeOut(opts.out, dump);
            }

            if (opts.json) {
                out.result(dump);
            } else {
                printIdbTables(dump, null);
            }

            process.exit(dump.error ? 1 : 0);
        });

    withPage(storage.command("web"))
        .description("list the picked tab's localStorage and sessionStorage, read-only")
        .option("--keys <a,b>", "only these keys (comma-separated)")
        .option("--json", "every key and full value as JSON on stdout")
        .option("-o, --out <file>", "write every key and full value as JSON to this file")
        .addHelpText(
            "after",
            `
Use it to check feature flags, auth state or cached settings a page keeps in Web Storage.
The table shows the start of each value; --json and -o carry the full values.

Examples:
  ${suggest(["storage", "web", "--match", "app.example.com"])}
  ${suggest(["storage", "web", "--match", "localhost:3000", "--keys", "theme,featureFlags", "--json"])}
  ${suggest(["storage", "web", "--match", "app.example.com", "-o", artifactPath("web-storage.json")])}`
        )
        .action(async (opts: WebOptions) => {
            const keys = opts.keys
                ?.split(",")
                .map((key) => key.trim())
                .filter(Boolean);
            const page = await attachTab(opts);
            out.log.info(`attached to: ${page.target.url}`);
            const dump = await dumpWebStorage(cdpLikeOf(page), keys?.length ? { keys } : {});
            page.close();

            if (opts.out) {
                await writeOut(opts.out, dump);
            }

            if (opts.json) {
                out.result(dump);
            } else {
                printWebStorage(dump);
            }

            process.exit(0);
        });
}
