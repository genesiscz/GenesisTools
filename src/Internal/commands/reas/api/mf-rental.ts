import * as XLSX from "xlsx";
import { cacheKey, getCached, MF_TTL, setCache } from "../cache/index";
import type { CacheEntry, MfRentalBenchmark } from "../types";

type CellValue = string | number | boolean | undefined;

/** Column indices for the 4 fixed metadata columns. */
const COL_CADASTRAL = 1;
const COL_MUNICIPALITY = 2;

/**
 * Each VK block has 9 data columns + 1 empty separator = 10 columns,
 * starting after the 4 metadata columns (offset 4).
 * Layout per block: VK, refPrice, confMin, confMax, newBuildPrice, min, max, median, coverage, (empty)
 */
const VK_BLOCK_SIZE = 10;
const VK_BLOCK_OFFSET = 4;
const VK_LABELS = ["VK1", "VK2", "VK3", "VK4"] as const;

/**
 * Relative offsets within each VK block (from the VK column itself):
 *   0 = VK number
 *   1 = reference price
 *   2 = confidence interval lower
 *   3 = confidence interval upper
 *   4 = new-build price
 *   5 = min value (not used in MfRentalBenchmark)
 *   6 = max value (not used in MfRentalBenchmark)
 *   7 = median
 *   8 = coverage score
 */
const OFF_REF_PRICE = 1;
const OFF_CONF_MIN = 2;
const OFF_CONF_MAX = 3;
const OFF_NEW_BUILD = 4;
const OFF_MEDIAN = 7;
const OFF_COVERAGE = 8;

/**
 * Compute the URL for the latest MF cenová mapa XLSX.
 *
 * Release schedule: Feb (Q1), May (Q2), Aug (Q3), Nov (Q4).
 * If the current month is before the quarter's release month,
 * fall back to the previous quarter's file.
 */
export function getLatestMfUrl(): string {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    // Quarter release months in ascending order
    const quarterMonths = [2, 5, 8, 11];

    // Find the latest release month that is <= current month
    const pastReleases = quarterMonths.filter((m) => m <= month);

    let releaseMonth: number;
    let releaseYear: number;

    if (pastReleases.length > 0) {
        releaseMonth = pastReleases[pastReleases.length - 1];
        releaseYear = year;
    } else {
        // Before February → use November of previous year
        releaseMonth = 11;
        releaseYear = year - 1;
    }

    const mm = String(releaseMonth).padStart(2, "0");
    return `https://mf.gov.cz/assets/attachments/${releaseYear}-${mm}-15_Cenova-mapa.xlsx`;
}

function cellNumber(sheet: XLSX.WorkSheet, row: number, col: number): number {
    const addr = XLSX.utils.encode_cell({ r: row, c: col });
    const cell = sheet[addr] as { v?: CellValue } | undefined;

    if (cell === undefined || cell.v === undefined) {
        return 0;
    }

    const num = Number(cell.v);
    return Number.isNaN(num) ? 0 : num;
}

function cellString(sheet: XLSX.WorkSheet, row: number, col: number): string {
    const addr = XLSX.utils.encode_cell({ r: row, c: col });
    const cell = sheet[addr] as { v?: CellValue } | undefined;

    if (cell === undefined || cell.v === undefined) {
        return "";
    }

    return String(cell.v);
}

/**
 * Parse a single VK block for a given row, returning an MfRentalBenchmark.
 */
function parseVkBlock(
    sheet: XLSX.WorkSheet,
    row: number,
    vkIndex: number,
    cadastralUnit: string,
    municipality: string
): MfRentalBenchmark {
    const blockStart = VK_BLOCK_OFFSET + vkIndex * VK_BLOCK_SIZE;

    return {
        cadastralUnit,
        municipality,
        sizeCategory: VK_LABELS[vkIndex],
        referencePrice: cellNumber(sheet, row, blockStart + OFF_REF_PRICE),
        confidenceMin: cellNumber(sheet, row, blockStart + OFF_CONF_MIN),
        confidenceMax: cellNumber(sheet, row, blockStart + OFF_CONF_MAX),
        median: cellNumber(sheet, row, blockStart + OFF_MEDIAN),
        newBuildPrice: cellNumber(sheet, row, blockStart + OFF_NEW_BUILD),
        coverageScore: cellNumber(sheet, row, blockStart + OFF_COVERAGE),
    };
}

/**
 * Download and parse the MF cenová mapa XLSX, returning all benchmarks
 * for the given municipality.
 */
async function downloadAndParse(municipality: string, url: string): Promise<MfRentalBenchmark[]> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`MF XLSX download failed: ${response.status} ${response.statusText} (${url})`);
    }

    const buffer = await response.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(buffer));

    const sheetName = workbook.SheetNames.find((name) => name.includes("Cenov")) ?? workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    if (!sheet || !sheet["!ref"]) {
        throw new Error(`MF XLSX: sheet "${sheetName}" is empty or missing`);
    }

    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const municipalityLower = municipality.toLowerCase();
    const results: MfRentalBenchmark[] = [];

    // Skip header row (r = 0), iterate data rows
    for (let r = 1; r <= range.e.r; r++) {
        const obec = cellString(sheet, r, COL_MUNICIPALITY);

        if (obec.toLowerCase() !== municipalityLower) {
            continue;
        }

        const cadastralUnit = cellString(sheet, r, COL_CADASTRAL);

        for (let vkIdx = 0; vkIdx < 4; vkIdx++) {
            const benchmark = parseVkBlock(sheet, r, vkIdx, cadastralUnit, obec);

            // Only include entries that have at least a reference price
            if (benchmark.referencePrice > 0) {
                results.push(benchmark);
            }
        }
    }

    return results;
}

/**
 * Fetch MF rental benchmark data for a municipality.
 *
 * Downloads the latest cenová mapa XLSX, parses it, and filters
 * to the given municipality. Results are cached for 7 days.
 *
 * @param municipality - Municipality name (e.g. "Hradec Králové")
 * @param refresh - Bypass cache if true
 */
export async function fetchMfRentalData(municipality: string, refresh = false): Promise<MfRentalBenchmark[]> {
    const url = getLatestMfUrl();
    const keyParams = { source: "mf-rental", municipality: municipality.toLowerCase(), url };
    const key = cacheKey(keyParams);

    if (!refresh) {
        const cached = await getCached<MfRentalBenchmark>(key, MF_TTL);

        if (cached) {
            return cached.data;
        }
    }

    const data = await downloadAndParse(municipality, url);

    const entry: CacheEntry<MfRentalBenchmark> = {
        fetchedAt: new Date().toISOString(),
        params: keyParams,
        count: data.length,
        data,
    };

    await setCache(key, entry);

    return data;
}
