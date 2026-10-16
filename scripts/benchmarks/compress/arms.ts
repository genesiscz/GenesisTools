/**
 * Two GENESIS_TOOLS_HOME roots for the read-path A/B (`read-paths.ts`): `plain` holds the day logs and two ai-proxy
 * transcripts as plain files, `zst` holds the same data the way the daily pass leaves it (days older than yesterday
 * and the transcripts as seekable `.zst`). Every other entry of the real `~/.genesis-tools` is a symlink, so the real
 * commands see the real daemon run logs, configs and caches. Built once into `<root>/<arm>` and reused (`--rebuild`
 * builds again). Reads the real data only; writes only under the bench root.
 */
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressFile, decompressFile } from "@genesiscz/utils/compress/file";
import { PRESETS } from "@genesiscz/utils/compress/presets";
import { formatLocalDate } from "@genesiscz/utils/date";
import { genesisToolsDir, genesisToolsDirIn } from "@genesiscz/utils/storage/root";

export const BENCH_ROOT = join(tmpdir(), "gt-bench-compress");
export const REAL_HOME = genesisToolsDir();
export const ARMS = ["plain", "zst"] as const;
export type Arm = (typeof ARMS)[number];

/** The two transcripts `tools ai-proxy calls --show` reads in the benchmark: the largest and a medium one. */
export const TRANSCRIPTS = {
    large: "2026-08-20/_untagged.jsonl",
    medium: "2026-07-25/filter-2026-07-25T05-11-51-788Z-g9zarv.jsonl",
} as const;

const DAY_MS = 86_400_000;

export function armHome(arm: Arm): string {
    return join(BENCH_ROOT, arm);
}

/** The last seven local days, newest first: what `tools daemon stats --since 7d` reads. */
export function benchDays(now = new Date()): string[] {
    return Array.from({ length: 7 }, (_, index) => formatLocalDate(new Date(now.getTime() - index * DAY_MS)));
}

/** Copy-on-write clone when the source is plain, a decompression when only the `.zst` is left. */
async function plainCopy(source: string, target: string): Promise<boolean> {
    if (existsSync(source)) {
        copyFileSync(source, target, 2 /* COPYFILE_FICLONE */);
        return true;
    }

    if (existsSync(`${source}.zst`)) {
        await decompressFile({ source: `${source}.zst`, target });
        return true;
    }

    return false;
}

async function zstCopy(source: string, target: string): Promise<boolean> {
    if (existsSync(`${source}.zst`)) {
        copyFileSync(`${source}.zst`, `${target}.zst`, 2);
        return true;
    }

    if (existsSync(source)) {
        await compressFile({ source, target: `${target}.zst`, ...PRESETS.text });
        return true;
    }

    return false;
}

function linkEverythingBut(from: string, to: string, except: string[]): void {
    mkdirSync(to, { recursive: true });

    for (const name of readdirSync(from)) {
        if (!except.includes(name) && !existsSync(join(to, name))) {
            symlinkSync(join(from, name), join(to, name));
        }
    }
}

export interface ArmInfo {
    home: string;
    logFiles: string[];
    bytes: number;
}

/** Builds (or reuses) one arm home. */
export async function buildArm(arm: Arm, { rebuild = false, now = new Date() } = {}): Promise<ArmInfo> {
    const home = armHome(arm);
    const tools = genesisToolsDirIn(home);
    const done = join(home, ".built");

    if (!existsSync(done) || rebuild) {
        linkEverythingBut(REAL_HOME, tools, ["logs", "ai-proxy", "compress"]);
        mkdirSync(join(tools, "logs"), { recursive: true });
        // The arm processes log here too; a claim file keeps the daily pass from starting in the arm.
        writeFileSync(join(tools, "logs", `.daily-compress-${formatLocalDate(now)}`), "");
        const days = benchDays(now);
        const plainDays = new Set(days.slice(0, 2));

        for (const day of days) {
            const source = join(REAL_HOME, "logs", `${day}.log`);
            const target = join(tools, "logs", `${day}.log`);
            const keepPlain = arm === "plain" || plainDays.has(day);

            if (!existsSync(target) && !existsSync(`${target}.zst`)) {
                await (keepPlain ? plainCopy(source, target) : zstCopy(source, target));
            }
        }

        linkEverythingBut(join(REAL_HOME, "ai-proxy"), join(tools, "ai-proxy"), ["usage", "transcripts"]);
        linkEverythingBut(join(REAL_HOME, "ai-proxy", "usage"), join(tools, "ai-proxy", "usage"), ["requests.jsonl"]);
        // The index stores absolute transcript paths; point them at this arm's copies.
        const realTranscripts = join(REAL_HOME, "ai-proxy", "transcripts");
        const index = readFileSync(join(REAL_HOME, "ai-proxy", "usage", "requests.jsonl"), "utf8");
        writeFileSync(
            join(tools, "ai-proxy", "usage", "requests.jsonl"),
            index.replaceAll(realTranscripts, join(tools, "ai-proxy", "transcripts"))
        );

        for (const relative of Object.values(TRANSCRIPTS)) {
            const target = join(tools, "ai-proxy", "transcripts", relative);
            mkdirSync(join(target, ".."), { recursive: true });

            if (!existsSync(target) && !existsSync(`${target}.zst`)) {
                await (arm === "plain"
                    ? plainCopy(join(realTranscripts, relative), target)
                    : zstCopy(join(realTranscripts, relative), target));
            }
        }

        writeFileSync(done, new Date().toISOString());
    }

    const logDir = join(tools, "logs");
    const logFiles = readdirSync(logDir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.log(\.zst)?$/.test(name))
        .map((name) => join(logDir, name));
    return { home, logFiles, bytes: logFiles.reduce((sum, file) => sum + lstatSync(file).size, 0) };
}
