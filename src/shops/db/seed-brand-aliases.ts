import logger from "@app/logger";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeBrand } from "../lib/normalize";
import type { BrandAliasesRepository } from "./BrandAliasesRepository";

const log = logger.child({ component: "seed-brand-aliases" });

const ARRAY_RE = /(?:BRANDS|brands|knownBrands|productBrands)\s*=\s*\[([^\]]*)\]/g;
const MAP_RE = /brandsMap\s*=\s*\{([^}]*)\}/g;
const STRING_LITERAL_RE = /"([^"\n]+)"|'([^'\n]+)'/g;

function looksLikeBrand(s: string): boolean {
    if (s.length < 2 || s.length > 60) {
        return false;
    }

    if (/^https?:\/\//.test(s)) {
        return false;
    }

    if (/[<>{}\\]/.test(s)) {
        return false;
    }

    return /[A-Za-zÁ-ž]/.test(s);
}

export function extractBrandsFromActor(jsSource: string): string[] {
    const out = new Set<string>();

    for (const match of jsSource.matchAll(ARRAY_RE)) {
        for (const lit of match[1].matchAll(STRING_LITERAL_RE)) {
            const brand = (lit[1] ?? lit[2]).trim();
            if (looksLikeBrand(brand)) {
                out.add(brand);
            }
        }
    }

    for (const match of jsSource.matchAll(MAP_RE)) {
        for (const line of match[1].split(/[,\n]/)) {
            const colonIdx = line.indexOf(":");
            if (colonIdx === -1) {
                continue;
            }

            const rhs = line
                .slice(colonIdx + 1)
                .trim()
                .replace(/^['"`]|['"`]$/g, "");
            if (looksLikeBrand(rhs)) {
                out.add(rhs);
            }
        }
    }

    return Array.from(out);
}

export interface SeedBrandAliasesArgs {
    repository: BrandAliasesRepository;
    brands?: string[];
    playgroundDir?: string;
}

export interface SeedBrandAliasesResult {
    inserted: number;
    skipped: number;
}

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function collectFromPlayground(playgroundDir: string): string[] {
    const actorsDir = join(playgroundDir, "actors");
    if (!isDir(actorsDir)) {
        log.warn({ actorsDir }, "playground actors dir missing");
        return [];
    }

    const out = new Set<string>();
    for (const entry of readdirSync(actorsDir)) {
        const mainJs = join(actorsDir, entry, "main.js");
        if (!isFile(mainJs)) {
            continue;
        }

        try {
            const src = readFileSync(mainJs, "utf8");
            for (const brand of extractBrandsFromActor(src)) {
                out.add(brand);
            }
        } catch (err) {
            log.warn({ entry, err }, "failed to read actor main.js");
        }
    }

    return Array.from(out);
}

export async function seedBrandAliases(args: SeedBrandAliasesArgs): Promise<SeedBrandAliasesResult> {
    const brands =
        args.brands ?? (args.playgroundDir ? collectFromPlayground(args.playgroundDir) : []);
    let inserted = 0;
    let skipped = 0;

    for (const brand of brands) {
        const canonical = normalizeBrand(brand);
        if (canonical === null) {
            continue;
        }

        const result = args.repository.upsertIfAbsent({
            alias: brand,
            canonical,
            source: "seed",
        });
        if (result === "inserted") {
            inserted += 1;
        } else {
            skipped += 1;
        }
    }

    log.info({ inserted, skipped }, "brand aliases seed run completed");
    return { inserted, skipped };
}
