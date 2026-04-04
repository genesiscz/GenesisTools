import { cacheKey, getCached, MF_TTL, setCache } from "@app/Internal/commands/reas/cache/index";
import { getCadastralMunicipalities } from "@app/Internal/commands/reas/data/cadastral-mapping";
import type { CacheEntry, MfRentalBenchmark } from "@app/Internal/commands/reas/types";
import { ApiClient } from "@app/utils/api/ApiClient";
import * as XLSX from "xlsx";
import type { CellValue } from "./MfRentalClient.types";

const COL_CADASTRAL = 1;
const COL_MUNICIPALITY = 2;
const VK_BLOCK_SIZE = 10;
const VK_BLOCK_OFFSET = 4;
const VK_LABELS = ["VK1", "VK2", "VK3", "VK4"] as const;

const OFF_REF_PRICE = 1;
const OFF_CONF_MIN = 2;
const OFF_CONF_MAX = 3;
const OFF_NEW_BUILD = 4;
const OFF_MEDIAN = 7;
const OFF_COVERAGE = 8;

export function getLatestMfUrl(now = new Date()): string {
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const quarterMonths = [2, 5, 8, 11];
    const pastReleases = quarterMonths.filter((releaseMonth) => releaseMonth <= month);

    let releaseMonth: number;
    let releaseYear: number;

    if (pastReleases.length > 0) {
        releaseMonth = pastReleases[pastReleases.length - 1];
        releaseYear = year;
    } else {
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

export class MfRentalClient {
    private readonly apiClient = new ApiClient({
        loggerContext: { provider: "mf-rental" },
    });

    getLatestUrl(now = new Date()): string {
        return getLatestMfUrl(now);
    }

    async fetchRentalData(municipality: string, refresh = false): Promise<MfRentalBenchmark[]> {
        const url = this.getLatestUrl();
        const keyParams = { source: "mf-rental", municipality: municipality.toLowerCase(), url };
        const key = cacheKey(keyParams);

        if (!refresh) {
            const cached = await getCached<MfRentalBenchmark>(key, MF_TTL);

            if (cached) {
                return cached.data;
            }
        }

        const data = await this.downloadAndParse(municipality, url);

        const entry: CacheEntry<MfRentalBenchmark> = {
            fetchedAt: new Date().toISOString(),
            params: keyParams,
            count: data.length,
            data,
        };

        await setCache(key, entry);

        return data;
    }

    private async downloadAndParse(municipality: string, url: string): Promise<MfRentalBenchmark[]> {
        const buffer = await this.apiClient.getArrayBuffer(url);
        const workbook = XLSX.read(new Uint8Array(buffer));
        const sheetName = workbook.SheetNames.find((name) => name.includes("Cenov")) ?? workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        if (!sheet || !sheet["!ref"]) {
            throw new Error(`MF XLSX: sheet "${sheetName}" is empty or missing`);
        }

        const range = XLSX.utils.decode_range(sheet["!ref"]);
        const municipalityLower = municipality.toLowerCase();
        const results: MfRentalBenchmark[] = [];

        for (let row = 1; row <= range.e.r; row++) {
            const obec = cellString(sheet, row, COL_MUNICIPALITY);

            if (obec.toLowerCase() !== municipalityLower) {
                continue;
            }

            const cadastralUnit = cellString(sheet, row, COL_CADASTRAL);

            for (let vkIndex = 0; vkIndex < 4; vkIndex++) {
                const benchmark = parseVkBlock(sheet, row, vkIndex, cadastralUnit, obec);

                if (benchmark.referencePrice > 0) {
                    results.push(benchmark);
                }
            }
        }

        return results;
    }

    async fetchRentalDataForDistrict(districtName: string, refresh = false): Promise<MfRentalBenchmark[]> {
        const municipalities = getCadastralMunicipalities(districtName);
        const results: MfRentalBenchmark[] = [];
        const seen = new Set<string>();

        for (const municipality of municipalities) {
            const benchmarks = await this.fetchRentalData(municipality, refresh);

            for (const benchmark of benchmarks) {
                const key = `${benchmark.cadastralUnit}:${benchmark.sizeCategory}`;

                if (!seen.has(key)) {
                    seen.add(key);
                    results.push(benchmark);
                }
            }
        }

        return results;
    }
}

export const mfRentalClient = new MfRentalClient();
