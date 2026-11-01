// Adapted from lukabudik/alza-mcp-community (MIT) — src/domain/pc-build.ts
/**
 * PC builder: spec normalisation and compatibility rules (issue #15).
 *
 * Everything in this module is pure: no network, no browser. The
 * orchestration that fetches products lives in `pc-build-service.ts`.
 *
 * Alza product pages carry their specs as Czech free-text name/value rows
 * (`get_product`'s `params`). The names differ slightly between page
 * templates, so each component type has a small alias map
 * (`SPEC_NAME_MAP`) that turns those rows into typed, normalised values
 * (`NormalizedSpecs`). Every normalised value keeps the Czech row name and
 * the raw value it came from, so a verdict can show exactly which spec it
 * compared.
 *
 * All spec names below were seen live on alza.cz product pages on
 * 2026-10-06 (CPU, motherboard, DDR5 kit, GeForce + Radeon GPU, two cases,
 * two PSUs, air + liquid CPU coolers, NVMe SSD). See
 * docs/live-evidence/2026-10-06-pc-builder.md.
 */
/** One spec row as the rules read it: the Czech row name and its value text. */
export interface ProductParam {
    name: string;
    value: string;
}

export const PC_ROLES = ["cpu", "motherboard", "ram", "gpu", "storage", "case", "cooler", "psu"] as const;
export type PcRole = (typeof PC_ROLES)[number];

/** Roles of which a build may contain several parts (all other roles: at most one). */
export const MULTI_ROLES: ReadonlySet<PcRole> = new Set<PcRole>(["ram", "storage"]);

/** A normalised spec value plus where it came from (Czech row name + raw value). */
export interface SpecValue<T> {
    value: T;
    /** Czech spec-row name the value was read from, e.g. "Max. délka grafické karty". */
    source: string;
    /** Raw row value as Alza shows it, e.g. "420 mm". */
    raw: string;
}

export interface NormalizedSpecs {
    /** CPU / motherboard socket, normalised: "AM5", "AM4", "LGA1700", "LGA1851", "TR5", … */
    socket?: SpecValue<string>;
    /** Memory generations: RAM kit type, motherboard slot type, or the CPU's supported list. */
    memoryTypes?: SpecValue<string[]>;
    /** DIMM / SO-DIMM / RDIMM (RAM kit and motherboard). */
    memoryFormFactor?: SpecValue<string>;
    /** Motherboard RAM slot count. */
    memorySlots?: SpecValue<number>;
    /** Number of modules in a RAM kit. */
    memoryModules?: SpecValue<number>;
    /** Motherboard form factor, normalised: "ATX", "mATX", "mITX", "eATX", … */
    formFactor?: SpecValue<string>;
    /** Case: supported motherboard form factors. */
    supportedFormFactors?: SpecValue<string[]>;
    /** CPU / GPU thermal design power in watts. */
    tdpW?: SpecValue<number>;
    /** GPU vendor's recommended PSU wattage. */
    recommendedPsuW?: SpecValue<number>;
    /** CPU has an integrated GPU (display output without a graphics card). */
    integratedGpu?: SpecValue<boolean>;
    /** GPU card length in mm (the longest of the card's dimension rows). */
    gpuLengthMm?: SpecValue<number>;
    /** Case: max graphics card length in mm. */
    maxGpuLengthMm?: SpecValue<number>;
    /** Air cooler height in mm. */
    coolerHeightMm?: SpecValue<number>;
    /** Case: max CPU cooler height in mm. */
    maxCoolerHeightMm?: SpecValue<number>;
    /** Cooler kind. */
    coolerType?: SpecValue<"air" | "liquid">;
    /** Liquid cooler radiator size in mm (120/240/280/360/420). */
    radiatorMm?: SpecValue<number>;
    /** Case: every supported radiator size, all mounting positions combined. */
    supportedRadiatorsMm?: SpecValue<number[]>;
    /** Cooler: supported sockets (AMD + Intel lists combined, normalised). */
    coolerSockets?: SpecValue<string[]>;
    /** PSU rated wattage. */
    psuWattage?: SpecValue<number>;
    /** PSU form factor: "ATX", "SFX", "SFX-L", "TFX", … */
    psuFormFactor?: SpecValue<string>;
    /** Case: supported PSU form factors. */
    supportedPsuFormFactors?: SpecValue<string[]>;
}

export type SpecKey = keyof NormalizedSpecs;

/**
 * Czech spec-row names per component type and normalised key, in priority
 * order (first match wins, except `gpuLengthMm` which takes the longest
 * dimension and `supportedRadiatorsMm`/`coolerSockets` which merge every
 * matching row). Matching ignores case, surrounding whitespace and HTML
 * entities. A trailing `*` matches any row name with that prefix.
 */
export const SPEC_NAME_MAP: Record<PcRole, Partial<Record<SpecKey, string[]>>> = {
    cpu: {
        socket: ["Socket", "Patice procesoru", "Patice"],
        memoryTypes: ["Podporovaný typ paměti", "Typ paměti"],
        tdpW: ["TDP", "Maximální TDP", "Základní výkon procesoru (TDP)"],
        integratedGpu: ["Typ integrované grafické karty", "Integrovaná grafická karta"],
    },
    motherboard: {
        socket: ["Socket", "Patice procesoru", "Patice"],
        memoryTypes: ["Typ paměti", "Podporovaný typ paměti"],
        memoryFormFactor: ["Provedení", "Typ slotů paměti"],
        memorySlots: ["Počet slotů RAM", "Počet paměťových slotů", "Počet slotů pro paměti"],
        formFactor: ["Formát základní desky", "Formát desky", "Formát"],
    },
    ram: {
        memoryTypes: ["Typ paměti"],
        memoryFormFactor: ["Provedení"],
        memoryModules: ["Počet modulů v balení", "Moduly v balení"],
    },
    gpu: {
        tdpW: ["TDP", "Spotřeba", "Maximální spotřeba", "Typický příkon"],
        recommendedPsuW: ["Doporučený výkon zdroje", "Doporučený zdroj", "Minimální výkon zdroje"],
        gpuLengthMm: ["Délka grafické karty", "Délka karty", "Délka", "Šířka", "Hloubka", "Výška"],
    },
    storage: {},
    case: {
        supportedFormFactors: ["Formát základní desky", "Podporované formáty základních desek"],
        maxGpuLengthMm: ["Max. délka grafické karty", "Maximální délka grafické karty", "Max. délka GPU"],
        maxCoolerHeightMm: [
            "Max. výška chladiče procesoru",
            "Maximální výška chladiče procesoru",
            "Max. výška CPU chladiče",
        ],
        supportedRadiatorsMm: ["Podporovaná velikost radiátoru*"],
        supportedPsuFormFactors: ["Podporovaný formát zdroje", "Formát zdroje"],
    },
    cooler: {
        coolerType: ["Chlazení", "Typ chlazení"],
        coolerHeightMm: ["Výška chladiče", "Výška"],
        radiatorMm: ["Kompatibilní velikost radiátoru", "Velikost radiátoru"],
        coolerSockets: ["AMD Socket", "Intel Socket", "Socket", "Podporované sockety"],
    },
    psu: {
        psuWattage: ["Výkon", "Výkon zdroje", "Maximální výkon"],
        psuFormFactor: ["Formát", "Formát zdroje"],
    },
};

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

function cleanName(s: string): string {
    return decodeEntities(s).replace(/\s+/g, " ").trim().toLowerCase();
}

function decodeEntities(s: string): string {
    return s
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&nbsp;/g, " ");
}

/**
 * First number in a Czech-formatted value: "291,9 mm" → 291.9,
 * "1 810 g" → 1810, "2 × 16GB" → 2, "750 W" → 750. Thousands separators
 * are (non-breaking) spaces, the decimal separator a comma.
 */
export function parseCzechNumber(raw: string): number | undefined {
    const m = raw.replace(/ /g, " ").match(/(\d{1,3}(?: \d{3})+|\d+)(?:[.,](\d+))?/);
    if (!m) {
        return undefined;
    }
    const int = (m[1] ?? "").replace(/ /g, "");
    const n = Number(m[2] ? `${int}.${m[2]}` : int);
    return Number.isFinite(n) ? n : undefined;
}

/** Comma-separated list rows ("ATX,mATX (Micro ATX),mITX (Mini ITX)"). */
export function splitList(raw: string): string[] {
    return decodeEntities(raw)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Socket normalisation: "AMD AM5" → "AM5", "Intel 1700" / "LGA 1700" /
 * "1700" → "LGA1700", "Intel 2011-3" → "LGA2011-3", "AMD TR5" / "sTR5" →
 * "TR5", "AM3+" → "AM3+", "FM2+" → "FM2+".
 */
export function normalizeSocket(raw: string): string {
    let s = decodeEntities(raw)
        .replace(/\b(AMD|Intel|socket|patice)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
    s = s.replace(/^LGA\s*/, "");
    if (/^\d{3,4}(-\d+)?$/.test(s)) {
        return `LGA${s}`;
    }
    s = s.replace(/^S(TRX?\d)/, "$1").replace(/\s+/g, "");
    return s;
}

/** Every DDR generation mentioned: "DDR4/DDR5" → ["DDR4","DDR5"], "PC5-48000 DDR5" → ["DDR5"]. */
export function parseMemoryTypes(raw: string): string[] {
    const out: string[] = [];
    for (const m of raw.toUpperCase().matchAll(/(LP)?DDR\s?(\d)/g)) {
        const t = `${m[1] ?? ""}DDR${m[2]}`;
        if (!out.includes(t)) {
            out.push(t);
        }
    }
    return out;
}

/** "SO-DIMM" / "SODIMM" → "SO-DIMM", "RDIMM" → "RDIMM", "DIMM" → "DIMM", else undefined. */
export function normalizeMemoryFormFactor(raw: string): string | undefined {
    const s = raw.toUpperCase();
    if (/SO-?DIMM/.test(s)) {
        return "SO-DIMM";
    }
    if (/\bRDIMM\b|REGISTERED/.test(s)) {
        return "RDIMM";
    }
    if (/\bU?DIMM\b/.test(s)) {
        return "DIMM";
    }
    return undefined;
}

/**
 * Motherboard form-factor normalisation: "mATX (Micro ATX)" / "Micro-ATX"
 * → "mATX", "mITX (Mini ITX)" / "Mini-ITX" → "mITX", "eATX (Extended ATX)"
 * / "E-ATX" → "eATX", "ATX" → "ATX"; others (CEB, EEB, SSI-CEB, …) upper-cased.
 */
export function normalizeFormFactor(raw: string): string {
    const s = decodeEntities(raw).trim();
    const u = s.toUpperCase().replace(/[\s_]+/g, " ");
    if (/^M-?ATX\b|MICRO[\s-]?ATX|ΜATX|UATX/.test(u)) {
        return "mATX";
    }
    if (/^M-?ITX\b|MINI[\s-]?ITX|^ITX$/.test(u)) {
        return "mITX";
    }
    if (/^E-?ATX\b|EXTENDED[\s-]?ATX/.test(u)) {
        return "eATX";
    }
    if (/^XL-?ATX/.test(u)) {
        return "XL-ATX";
    }
    if (/^ATX\b/.test(u)) {
        return "ATX";
    }
    return u.replace(/\s*\(.*\)$/, "");
}

/** PSU form factors: "ATX" / "ATX 3.1" → "ATX", "SFX-L" → "SFX-L", "SFX" → "SFX", "TFX" → "TFX". */
export function normalizePsuFormFactor(raw: string): string {
    const u = raw.toUpperCase();
    if (/SFX-?L/.test(u)) {
        return "SFX-L";
    }
    if (/SFX/.test(u)) {
        return "SFX";
    }
    if (/TFX/.test(u)) {
        return "TFX";
    }
    if (/FLEX/.test(u)) {
        return "FLEX ATX";
    }
    if (/ATX|PS\/?2/.test(u)) {
        return "ATX";
    }
    return u.trim();
}

/** Radiator sizes in a row: "120mm,140mm,240mm,280mm,360mm" → [120,140,240,280,360]. */
export function parseRadiatorSizes(raw: string): number[] {
    const out: number[] = [];
    for (const m of raw.matchAll(/(\d{3})\s*mm/gi)) {
        const n = Number(m[1]);
        if (!out.includes(n)) {
            out.push(n);
        }
    }
    return out.sort((a, b) => a - b);
}

/** Cooler socket rows ("AM4,AM5" / "1150,1151,1700,2011-3") → normalised socket list. */
export function parseSocketList(raw: string): string[] {
    return splitList(raw).map(normalizeSocket).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function findRows(params: ProductParam[], aliases: string[]): ProductParam[] {
    const out: ProductParam[] = [];
    for (const alias of aliases) {
        const a = alias.toLowerCase();
        const prefix = a.endsWith("*") ? a.slice(0, -1) : null;
        for (const p of params) {
            const n = cleanName(p.name);
            if (prefix ? n.startsWith(prefix) : n === a) {
                if (!out.includes(p)) {
                    out.push(p);
                }
            }
        }
    }
    return out;
}

function first<T>(rows: ProductParam[], parse: (raw: string) => T | undefined): SpecValue<T> | undefined {
    for (const r of rows) {
        const raw = decodeEntities(r.value).trim();
        const v = parse(raw);
        if (v !== undefined && !(Array.isArray(v) && v.length === 0)) {
            return { value: v, source: r.name.trim(), raw };
        }
    }
    return undefined;
}

/**
 * Map a product's raw Czech spec rows to normalised specs for a role,
 * using `SPEC_NAME_MAP`. Rows the map doesn't know are ignored; a key
 * whose row is missing stays undefined (rules then say `unknown`).
 */
export function normalizeSpecs(role: PcRole, params: ProductParam[] | undefined): NormalizedSpecs {
    const ps = params ?? [];
    const map = SPEC_NAME_MAP[role];
    const rows = (k: SpecKey) => findRows(ps, map[k] ?? []);
    const out: NormalizedSpecs = {};
    const num = (raw: string) => parseCzechNumber(raw);

    if (map.socket) {
        out.socket = first(rows("socket"), (r) => normalizeSocket(r) || undefined);
    }
    if (map.memoryTypes) {
        out.memoryTypes = first(rows("memoryTypes"), parseMemoryTypes);
    }
    if (map.memoryFormFactor) {
        out.memoryFormFactor = first(rows("memoryFormFactor"), normalizeMemoryFormFactor);
    }
    if (map.memorySlots) {
        out.memorySlots = first(rows("memorySlots"), num);
    }
    if (map.memoryModules) {
        out.memoryModules = first(rows("memoryModules"), num);
    }
    if (map.formFactor) {
        out.formFactor = first(rows("formFactor"), (r) => normalizeFormFactor(splitList(r)[0] ?? r));
    }
    if (map.supportedFormFactors) {
        out.supportedFormFactors = first(rows("supportedFormFactors"), (r) => splitList(r).map(normalizeFormFactor));
    }
    if (map.tdpW) {
        out.tdpW = first(rows("tdpW"), num);
    }
    if (map.recommendedPsuW) {
        out.recommendedPsuW = first(rows("recommendedPsuW"), num);
    }
    if (map.integratedGpu) {
        out.integratedGpu = first(rows("integratedGpu"), (r) => !/^(bez|ne|žádn|none|no\b)/i.test(r.trim()));
    }
    if (map.gpuLengthMm) {
        // Alza lists GPU dimensions as Šířka/Výška/Hloubka with the card length
        // usually under "Šířka" (live 2026-10-06: 291,9 / 41,3 / 116,5 mm). The
        // card's length is always its longest dimension, so take the maximum.
        let best: SpecValue<number> | undefined;
        for (const r of rows("gpuLengthMm")) {
            const raw = decodeEntities(r.value).trim();
            if (!/mm|cm/i.test(raw)) {
                continue;
            }
            let v = parseCzechNumber(raw);
            if (v === undefined) {
                continue;
            }
            if (/\bcm\b/i.test(raw) && !/mm/i.test(raw)) {
                v = v * 10;
            }
            if (!best || v > best.value) {
                best = { value: v, source: r.name.trim(), raw };
            }
        }
        out.gpuLengthMm = best;
    }
    if (map.maxGpuLengthMm) {
        out.maxGpuLengthMm = first(rows("maxGpuLengthMm"), num);
    }
    if (map.maxCoolerHeightMm) {
        out.maxCoolerHeightMm = first(rows("maxCoolerHeightMm"), num);
    }
    if (map.supportedRadiatorsMm) {
        const rr = rows("supportedRadiatorsMm");
        const sizes = new Set<number>();
        for (const r of rr) {
            for (const n of parseRadiatorSizes(r.value)) {
                sizes.add(n);
            }
        }
        if (sizes.size > 0) {
            out.supportedRadiatorsMm = {
                value: [...sizes].sort((a, b) => a - b),
                source: rr.map((r) => r.name.trim()).join(" + "),
                raw: rr.map((r) => `${r.name.trim()}: ${r.value}`).join("; "),
            };
        }
    }
    if (map.supportedPsuFormFactors) {
        out.supportedPsuFormFactors = first(rows("supportedPsuFormFactors"), (r) =>
            splitList(r).map(normalizePsuFormFactor)
        );
    }
    if (map.coolerType) {
        out.coolerType = first(rows("coolerType"), (r): "air" | "liquid" | undefined =>
            /vod|liquid|kapal/i.test(r) ? "liquid" : /vzduch|air|pasiv|aktiv/i.test(r) ? "air" : undefined
        );
    }
    if (map.radiatorMm) {
        out.radiatorMm = first(rows("radiatorMm"), (r) => parseRadiatorSizes(r)[0] ?? undefined);
    }
    if (map.coolerSockets) {
        const rr = rows("coolerSockets");
        const all: string[] = [];
        for (const r of rr) {
            for (const s of parseSocketList(r.value)) {
                if (!all.includes(s)) {
                    all.push(s);
                }
            }
        }
        if (all.length > 0) {
            out.coolerSockets = {
                value: all,
                source: rr.map((r) => r.name.trim()).join(" + "),
                raw: rr.map((r) => `${r.name.trim()}: ${r.value}`).join("; "),
            };
        }
    }
    if (map.coolerHeightMm) {
        // A liquid cooler's "Výška" is the pump/radiator, not a tower height.
        const liquid = out.coolerType?.value === "liquid" || out.radiatorMm !== undefined;
        if (!liquid) {
            out.coolerHeightMm = first(rows("coolerHeightMm"), num);
        }
        if (!out.coolerType) {
            out.coolerType = liquid
                ? { value: "liquid", source: out.radiatorMm!.source, raw: out.radiatorMm!.raw }
                : undefined;
        }
    }
    if (map.psuWattage) {
        out.psuWattage = first(rows("psuWattage"), (r) => (/\bW\b|W$/i.test(r) ? parseCzechNumber(r) : undefined));
    }
    if (map.psuFormFactor) {
        out.psuFormFactor = first(rows("psuFormFactor"), normalizePsuFormFactor);
    }
    // drop undefined keys so JSON output stays compact
    for (const k of Object.keys(out) as SpecKey[]) {
        if (out[k] === undefined) {
            delete out[k];
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Role detection
// ---------------------------------------------------------------------------

function has(params: ProductParam[], ...names: string[]): boolean {
    const set = new Set(params.map((p) => cleanName(p.name)));
    return names.some((n) => set.has(n.toLowerCase()));
}

/**
 * Why a product is clearly not a single PC component (a laptop, prebuilt PC
 * or monitor carries display / operating-system rows that no component page
 * has), or undefined when it may be one. Such a product matches the RAM or
 * CPU spec signature by accident (it lists memory type, frequency and size).
 */
export function nonComponentReason(params: ProductParam[] | undefined): string | undefined {
    const ps = params ?? [];
    if (has(ps, "Úhlopříčka displeje", "Typ displeje", "Operační systém")) {
        return "its specs describe a complete device (display / operating system rows) — a laptop, prebuilt PC or monitor, not a single PC component";
    }
    return undefined;
}

/** Role from the spec-row signature only (strong evidence); undefined when no signature matches. */
export function detectRoleFromSpecs(params: ProductParam[] | undefined): PcRole | undefined {
    const ps = params ?? [];
    if (nonComponentReason(ps)) {
        return undefined;
    }
    if (has(ps, "Socket") && has(ps, "Čipset", "Formát základní desky")) {
        return "motherboard";
    }
    if (has(ps, "Socket", "Řada procesoru") && has(ps, "Počet jader procesoru", "Řada procesoru")) {
        return "cpu";
    }
    if (has(ps, "Max. délka grafické karty", "Max. výška chladiče procesoru")) {
        return "case";
    }
    if (has(ps, "Kapacita VRAM", "Výrobce čipu", "Grafický procesor")) {
        return "gpu";
    }
    if (has(ps, "AMD Socket", "Intel Socket")) {
        return "cooler";
    }
    if (has(ps, "Výkon") && has(ps, "Certifikace", "Modulárnost", "Verze ATX")) {
        return "psu";
    }
    if (
        has(ps, "Typ paměti") &&
        has(ps, "Frekvence paměti") &&
        has(ps, "Moduly v balení", "Počet modulů v balení", "Velikost operační paměti RAM")
    ) {
        return "ram";
    }
    if (has(ps, "Typ úložiště", "Kapacita úložiště (celková)", "Rozhraní interní")) {
        return "storage";
    }
    return undefined;
}

/**
 * Best-guess component role from a product's spec-row signature, falling
 * back to name keywords. Returns undefined when nothing matches (or when the
 * product is a whole device) — callers then ask for an explicit `role`.
 */
export function detectRole(name: string, params: ProductParam[] | undefined): PcRole | undefined {
    if (nonComponentReason(params)) {
        return undefined;
    }
    const fromSpecs = detectRoleFromSpecs(params);
    if (fromSpecs) {
        return fromSpecs;
    }
    const n = name.toLowerCase();
    if (
        /\b(ryzen|core i[3579]|core ultra|threadripper|xeon|athlon|pentium|celeron)\b/.test(n) &&
        !/notebook|počítač/.test(n)
    ) {
        return "cpu";
    }
    if (/\b(geforce|radeon rx|rtx \d|gtx \d|arc [ab]\d)/.test(n)) {
        return "gpu";
    }
    if (/\bddr[345]\b/.test(n)) {
        return "ram";
    }
    if (/\b(ssd|nvme|hdd)\b/.test(n)) {
        return "storage";
    }
    return undefined;
}

/**
 * Sanity-check an explicitly requested role against the product's specs.
 * `error` = the specs clearly describe something else (a whole device, or
 * another component's signature) — the caller refuses the part instead of
 * running rules on the wrong role. `warning` = only the name hints at
 * another role. Parts without a recognisable signature are accepted.
 */
export function checkForcedRole(
    role: PcRole,
    name: string,
    params: ProductParam[] | undefined
): { error?: string; warning?: string } {
    const device = nonComponentReason(params);
    if (device) {
        return { error: `${name} cannot be used as ${role}: ${device}.` };
    }
    const fromSpecs = detectRoleFromSpecs(params);
    if (fromSpecs && fromSpecs !== role) {
        return {
            error: `${name} was given role ${role}, but its spec table looks like a ${fromSpecs}. Fix the role (or drop it to auto-detect).`,
        };
    }
    if (!fromSpecs) {
        const fromName = detectRole(name, params);
        if (fromName && fromName !== role) {
            return {
                warning: `${name} was given role ${role}, but its name suggests ${fromName}; its specs confirmed neither.`,
            };
        }
    }
    return {};
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type Verdict = "pass" | "warn" | "fail" | "unknown" | "not_applicable";

export interface RuleVerdict {
    rule: RuleId;
    title: string;
    verdict: Verdict;
    /** One-sentence explanation including the compared values. */
    detail: string;
    /** The spec values used — each with the Czech row name it came from. */
    values: Record<string, { value: unknown; source?: string; raw?: string; part?: string } | null>;
}

export type RuleId =
    | "cpu_socket_motherboard"
    | "ram_motherboard"
    | "ram_cpu"
    | "psu_wattage"
    | "gpu_length_case"
    | "cooler_clearance_case"
    | "cooler_socket"
    | "motherboard_form_factor_case"
    | "psu_form_factor_case"
    | "display_output";

export const RULE_TITLES: Record<RuleId, string> = {
    cpu_socket_motherboard: "CPU socket ↔ motherboard socket",
    ram_motherboard: "RAM generation / module type / slots ↔ motherboard",
    ram_cpu: "RAM generation ↔ CPU memory controller",
    psu_wattage: "PSU wattage vs estimated draw + headroom",
    gpu_length_case: "GPU length ↔ case clearance",
    cooler_clearance_case: "CPU cooler height / radiator ↔ case",
    cooler_socket: "CPU cooler ↔ CPU socket",
    motherboard_form_factor_case: "Motherboard form factor ↔ case",
    psu_form_factor_case: "PSU form factor ↔ case",
    display_output: "Display output (GPU or CPU integrated graphics)",
};

/** A part as the rules see it: code + normalised specs. */
export interface RulePart {
    code: string;
    name?: string;
    specs: NormalizedSpecs;
}

export type BuildParts = Partial<Record<Exclude<PcRole, "ram" | "storage">, RulePart>> & {
    ram?: RulePart[];
    storage?: RulePart[];
};

function sv<T>(
    part: RulePart | undefined,
    key: SpecKey
): { value: T; source?: string; raw?: string; part?: string } | null {
    const s = part?.specs[key] as SpecValue<T> | undefined;
    return s ? { value: s.value, source: s.source, raw: s.raw, part: part!.code } : null;
}

function verdict(rule: RuleId, v: Verdict, detail: string, values: RuleVerdict["values"] = {}): RuleVerdict {
    return { rule, title: RULE_TITLES[rule], verdict: v, detail, values };
}

function missing(rule: RuleId, what: string[], values: RuleVerdict["values"]): RuleVerdict {
    return verdict(
        rule,
        "unknown",
        `Cannot check: spec missing — ${what.join(", ")}. Verify on the product page.`,
        values
    );
}

export function checkCpuSocket(cpu?: RulePart, mb?: RulePart): RuleVerdict {
    const rule = "cpu_socket_motherboard";
    if (!cpu || !mb) {
        return verdict(rule, "not_applicable", "Needs both a CPU and a motherboard.");
    }
    const values = { cpuSocket: sv(cpu, "socket"), motherboardSocket: sv(mb, "socket") };
    const a = cpu.specs.socket?.value;
    const b = mb.specs.socket?.value;
    if (!a || !b) {
        return missing(rule, [!a ? "CPU Socket" : "", !b ? "motherboard Socket" : ""].filter(Boolean), values);
    }
    return a === b
        ? verdict(rule, "pass", `CPU socket ${a} matches the motherboard socket ${b}.`, values)
        : verdict(rule, "fail", `CPU socket ${a} does not fit the motherboard socket ${b}.`, values);
}

export function checkRamMotherboard(ram: RulePart[] | undefined, mb?: RulePart): RuleVerdict {
    const rule = "ram_motherboard";
    if (!ram?.length || !mb) {
        return verdict(rule, "not_applicable", "Needs RAM and a motherboard.");
    }
    const values: RuleVerdict["values"] = {
        motherboardMemoryTypes: sv(mb, "memoryTypes"),
        motherboardMemoryFormFactor: sv(mb, "memoryFormFactor"),
        motherboardSlots: sv(mb, "memorySlots"),
    };
    ram.forEach((r, i) => {
        values[`ram${i + 1}MemoryTypes`] = sv(r, "memoryTypes");
        values[`ram${i + 1}FormFactor`] = sv(r, "memoryFormFactor");
        values[`ram${i + 1}Modules`] = sv(r, "memoryModules");
    });
    const mbTypes = mb.specs.memoryTypes?.value;
    if (!mbTypes) {
        return missing(rule, ["motherboard Typ paměti"], values);
    }
    const problems: string[] = [];
    const unknowns: string[] = [];
    const warns: string[] = [];
    let modules = 0;
    let modulesKnown = true;
    for (const r of ram) {
        const t = r.specs.memoryTypes?.value;
        if (!t) {
            unknowns.push(`${r.code} Typ paměti`);
        } else if (!t.some((x) => mbTypes.includes(x))) {
            problems.push(`${r.code} is ${t.join("/")} but the board takes ${mbTypes.join("/")}`);
        }
        const rf = r.specs.memoryFormFactor?.value;
        const mf = mb.specs.memoryFormFactor?.value ?? "DIMM";
        if (rf && rf !== mf) {
            problems.push(`${r.code} is ${rf} but the board has ${mf} slots`);
        }
        const m = r.specs.memoryModules?.value;
        if (m === undefined) {
            modulesKnown = false;
        } else {
            modules += m;
        }
    }
    const slots = mb.specs.memorySlots?.value;
    if (slots !== undefined && modulesKnown && modules > slots) {
        problems.push(`${modules} modules but only ${slots} slots`);
    }
    if (slots === undefined) {
        warns.push("slot count unknown");
    }
    if (problems.length) {
        return verdict(rule, "fail", `Incompatible: ${problems.join("; ")}.`, values);
    }
    if (unknowns.length) {
        return missing(rule, unknowns, values);
    }
    const detail =
        `RAM ${[...new Set(ram.flatMap((r) => r.specs.memoryTypes!.value))].join("/")} fits the board's ${mbTypes.join("/")} slots` +
        (slots !== undefined && modulesKnown ? ` (${modules}/${slots} slots used).` : ".");
    return verdict(
        rule,
        warns.length ? "warn" : "pass",
        warns.length ? `${detail} Note: ${warns.join("; ")}.` : detail,
        values
    );
}

export function checkRamCpu(ram: RulePart[] | undefined, cpu?: RulePart): RuleVerdict {
    const rule = "ram_cpu";
    if (!ram?.length || !cpu) {
        return verdict(rule, "not_applicable", "Needs RAM and a CPU.");
    }
    const values: RuleVerdict["values"] = { cpuMemoryTypes: sv(cpu, "memoryTypes") };
    for (const [i, r] of ram.entries()) {
        values[`ram${i + 1}MemoryTypes`] = sv(r, "memoryTypes");
    }
    const cpuTypes = cpu.specs.memoryTypes?.value;
    if (!cpuTypes) {
        return missing(rule, ["CPU Podporovaný typ paměti"], values);
    }
    const bad = ram.filter((r) => r.specs.memoryTypes && !r.specs.memoryTypes.value.some((t) => cpuTypes.includes(t)));
    if (bad.length) {
        return verdict(
            rule,
            "fail",
            `CPU supports ${cpuTypes.join("/")} but ${bad.map((r) => `${r.code} is ${r.specs.memoryTypes!.value.join("/")}`).join(", ")}.`,
            values
        );
    }
    if (ram.some((r) => !r.specs.memoryTypes)) {
        return missing(rule, ["RAM Typ paměti"], values);
    }
    return verdict(rule, "pass", `CPU memory controller supports ${cpuTypes.join("/")}; the RAM matches.`, values);
}

/** Watts for the motherboard, RAM, storage and fans together (conservative). */
export const PLATFORM_DRAW_W = 75;
/** CPU boost allowance over TDP (AMD PPT = 1.35 × TDP; Intel PL2 is often higher, so this is a floor). */
export const CPU_BOOST_FACTOR = 1.35;
/** GPU board power ≈ 40 % of the vendor's recommended PSU when no TDP row exists. */
export const GPU_FROM_RECOMMENDED_PSU = 0.4;
/** Fallbacks when a spec is missing entirely (flagged as assumptions). */
export const ASSUMED_CPU_W = 150;
export const ASSUMED_GPU_W = 250;
export const DEFAULT_PSU_HEADROOM = 0.3;

export interface PowerEstimate {
    cpuW: number;
    gpuW: number;
    platformW: number;
    totalW: number;
    /** total × (1 + headroom), rounded up to 10 W, and at least the GPU vendor's recommendation. */
    recommendedPsuW: number;
    headroom: number;
    assumptions: string[];
    /** true when a CPU/GPU power figure is a blind fallback (no spec row at all), not derived from a listed spec. */
    usedFallback: boolean;
}

export function estimatePower(parts: Pick<BuildParts, "cpu" | "gpu">, headroom = DEFAULT_PSU_HEADROOM): PowerEstimate {
    const assumptions: string[] = [];
    let usedFallback = false;
    let cpuW = 0;
    if (parts.cpu) {
        const tdp = parts.cpu.specs.tdpW?.value;
        if (tdp !== undefined) {
            cpuW = Math.round(tdp * CPU_BOOST_FACTOR);
        } else {
            cpuW = ASSUMED_CPU_W;
            usedFallback = true;
            assumptions.push(`CPU TDP unknown — assumed ${ASSUMED_CPU_W} W`);
        }
    }
    let gpuW = 0;
    const rec = parts.gpu?.specs.recommendedPsuW?.value;
    if (parts.gpu) {
        const tdp = parts.gpu.specs.tdpW?.value;
        if (tdp !== undefined) {
            gpuW = tdp;
        } else if (rec !== undefined) {
            gpuW = Math.round(rec * GPU_FROM_RECOMMENDED_PSU);
            assumptions.push(`GPU TDP not listed — estimated ${gpuW} W from the recommended ${rec} W PSU`);
        } else {
            gpuW = ASSUMED_GPU_W;
            usedFallback = true;
            assumptions.push(`GPU power unknown — assumed ${ASSUMED_GPU_W} W`);
        }
    }
    const totalW = cpuW + gpuW + PLATFORM_DRAW_W;
    const withHeadroom = Math.ceil((totalW * (1 + headroom)) / 10) * 10;
    return {
        cpuW,
        gpuW,
        platformW: PLATFORM_DRAW_W,
        totalW,
        recommendedPsuW: Math.max(withHeadroom, rec ?? 0),
        headroom,
        assumptions,
        usedFallback,
    };
}

export function checkPsuWattage(parts: BuildParts, headroom = DEFAULT_PSU_HEADROOM): RuleVerdict {
    const rule = "psu_wattage";
    const psu = parts.psu;
    if (!psu) {
        return verdict(rule, "not_applicable", "No PSU in the build.");
    }
    if (!parts.cpu && !parts.gpu) {
        return verdict(rule, "not_applicable", "Needs a CPU or GPU to estimate the draw.");
    }
    const est = estimatePower(parts, headroom);
    const values: RuleVerdict["values"] = {
        psuWattage: sv(psu, "psuWattage"),
        cpuTdp: sv(parts.cpu, "tdpW"),
        gpuTdp: sv(parts.gpu, "tdpW"),
        gpuRecommendedPsu: sv(parts.gpu, "recommendedPsuW"),
        estimate: { value: est },
    };
    const w = psu.specs.psuWattage?.value;
    if (w === undefined) {
        return missing(rule, ["PSU Výkon"], values);
    }
    const basis = `estimated draw ${est.totalW} W (CPU ${est.cpuW} + GPU ${est.gpuW} + platform ${est.platformW}), recommended ≥ ${est.recommendedPsuW} W with ${Math.round(headroom * 100)} % headroom`;
    const note = est.assumptions.length ? ` Assumptions: ${est.assumptions.join("; ")}.` : "";
    if (w < est.totalW) {
        return verdict(rule, "fail", `PSU ${w} W is below the ${basis}.${note}`, values);
    }
    if (w < est.recommendedPsuW) {
        return verdict(rule, "warn", `PSU ${w} W covers the draw but not the headroom: ${basis}.${note}`, values);
    }
    // A blind fallback (no power spec at all) can't vouch for a pass; a figure
    // derived from the GPU's listed PSU recommendation can (it's in `detail`).
    return verdict(rule, est.usedFallback ? "warn" : "pass", `PSU ${w} W ≥ ${basis}.${note}`, values);
}

export function checkGpuLength(gpu?: RulePart, pcCase?: RulePart): RuleVerdict {
    const rule = "gpu_length_case";
    if (!gpu || !pcCase) {
        return verdict(rule, "not_applicable", "Needs a GPU and a case.");
    }
    const values = { gpuLengthMm: sv(gpu, "gpuLengthMm"), caseMaxGpuLengthMm: sv(pcCase, "maxGpuLengthMm") };
    const len = gpu.specs.gpuLengthMm?.value;
    const max = pcCase.specs.maxGpuLengthMm?.value;
    if (len === undefined || max === undefined) {
        return missing(
            rule,
            [
                len === undefined ? "GPU length (Šířka/Délka)" : "",
                max === undefined ? "case Max. délka grafické karty" : "",
            ].filter(Boolean),
            values
        );
    }
    const spare = Math.round((max - len) * 10) / 10;
    if (len > max) {
        return verdict(rule, "fail", `GPU is ${len} mm long but the case fits at most ${max} mm.`, values);
    }
    if (spare < 10) {
        return verdict(
            rule,
            "warn",
            `GPU ${len} mm fits the case's ${max} mm with only ${spare} mm to spare (front fans/radiator may collide).`,
            values
        );
    }
    return verdict(rule, "pass", `GPU ${len} mm fits the case's ${max} mm limit (${spare} mm spare).`, values);
}

export function checkCoolerClearance(cooler?: RulePart, pcCase?: RulePart): RuleVerdict {
    const rule = "cooler_clearance_case";
    if (!cooler || !pcCase) {
        return verdict(rule, "not_applicable", "Needs a CPU cooler and a case.");
    }
    const liquid = cooler.specs.coolerType?.value === "liquid" || cooler.specs.radiatorMm !== undefined;
    if (liquid) {
        const values = { radiatorMm: sv(cooler, "radiatorMm"), caseRadiatorsMm: sv(pcCase, "supportedRadiatorsMm") };
        const rad = cooler.specs.radiatorMm?.value;
        const sup = pcCase.specs.supportedRadiatorsMm?.value;
        if (rad === undefined || !sup) {
            return missing(
                rule,
                [
                    rad === undefined ? "cooler Kompatibilní velikost radiátoru" : "",
                    !sup ? "case Podporovaná velikost radiátoru" : "",
                ].filter(Boolean),
                values
            );
        }
        return sup.includes(rad)
            ? verdict(rule, "pass", `${rad} mm radiator is supported by the case (${sup.join("/")} mm).`, values)
            : verdict(
                  rule,
                  "fail",
                  `${rad} mm radiator is not supported by the case (only ${sup.join("/")} mm).`,
                  values
              );
    }
    const values = {
        coolerHeightMm: sv(cooler, "coolerHeightMm"),
        caseMaxCoolerHeightMm: sv(pcCase, "maxCoolerHeightMm"),
    };
    const h = cooler.specs.coolerHeightMm?.value;
    const max = pcCase.specs.maxCoolerHeightMm?.value;
    if (h === undefined || max === undefined) {
        return missing(
            rule,
            [
                h === undefined ? "cooler Výška" : "",
                max === undefined ? "case Max. výška chladiče procesoru" : "",
            ].filter(Boolean),
            values
        );
    }
    if (h > max) {
        return verdict(rule, "fail", `Cooler is ${h} mm tall but the case allows ${max} mm.`, values);
    }
    if (max - h < 3) {
        return verdict(rule, "warn", `Cooler ${h} mm fits the case's ${max} mm with under 3 mm to spare.`, values);
    }
    return verdict(rule, "pass", `Cooler ${h} mm fits under the case's ${max} mm limit.`, values);
}

export function checkCoolerSocket(cooler?: RulePart, cpu?: RulePart): RuleVerdict {
    const rule = "cooler_socket";
    if (!cooler || !cpu) {
        return verdict(rule, "not_applicable", "Needs a CPU cooler and a CPU.");
    }
    const values = { cpuSocket: sv(cpu, "socket"), coolerSockets: sv(cooler, "coolerSockets") };
    const s = cpu.specs.socket?.value;
    const list = cooler.specs.coolerSockets?.value;
    if (!s || !list) {
        return missing(rule, [!s ? "CPU Socket" : "", !list ? "cooler AMD/Intel Socket" : ""].filter(Boolean), values);
    }
    return list.includes(s)
        ? verdict(rule, "pass", `Cooler lists ${s} among its supported sockets.`, values)
        : verdict(rule, "fail", `Cooler does not list ${s} (supports ${list.join(", ")}).`, values);
}

export function checkMotherboardFormFactor(mb?: RulePart, pcCase?: RulePart): RuleVerdict {
    const rule = "motherboard_form_factor_case";
    if (!mb || !pcCase) {
        return verdict(rule, "not_applicable", "Needs a motherboard and a case.");
    }
    const values = { motherboardFormFactor: sv(mb, "formFactor"), caseFormFactors: sv(pcCase, "supportedFormFactors") };
    const f = mb.specs.formFactor?.value;
    const list = pcCase.specs.supportedFormFactors?.value;
    if (!f || !list) {
        return missing(
            rule,
            [!f ? "motherboard Formát základní desky" : "", !list ? "case Formát základní desky" : ""].filter(Boolean),
            values
        );
    }
    return list.includes(f)
        ? verdict(rule, "pass", `${f} board is supported by the case (${list.join(", ")}).`, values)
        : verdict(rule, "fail", `${f} board is not supported by the case (${list.join(", ")}).`, values);
}

export function checkPsuFormFactor(psu?: RulePart, pcCase?: RulePart): RuleVerdict {
    const rule = "psu_form_factor_case";
    if (!psu || !pcCase) {
        return verdict(rule, "not_applicable", "Needs a PSU and a case.");
    }
    const values = {
        psuFormFactor: sv(psu, "psuFormFactor"),
        casePsuFormFactors: sv(pcCase, "supportedPsuFormFactors"),
    };
    const f = psu.specs.psuFormFactor?.value;
    const list = pcCase.specs.supportedPsuFormFactors?.value;
    if (!f || !list) {
        return missing(
            rule,
            [!f ? "PSU Formát" : "", !list ? "case Podporovaný formát zdroje" : ""].filter(Boolean),
            values
        );
    }
    // ATX cases usually also take SFX(-L) with an adapter bracket.
    if (list.includes(f)) {
        return verdict(rule, "pass", `${f} PSU is supported by the case.`, values);
    }
    if (list.includes("ATX") && (f === "SFX" || f === "SFX-L")) {
        return verdict(rule, "warn", `${f} PSU in an ATX-PSU case needs an SFX-to-ATX adapter bracket.`, values);
    }
    return verdict(rule, "fail", `${f} PSU is not supported by the case (${list.join(", ")}).`, values);
}

export function checkDisplayOutput(cpu?: RulePart, gpu?: RulePart): RuleVerdict {
    const rule = "display_output";
    if (gpu) {
        return verdict(rule, "pass", "A dedicated graphics card provides display output.", {
            gpu: { value: gpu.code },
        });
    }
    if (!cpu) {
        return verdict(rule, "not_applicable", "Needs a CPU or GPU.");
    }
    const values = { cpuIntegratedGpu: sv(cpu, "integratedGpu") };
    const igpu = cpu.specs.integratedGpu?.value;
    if (igpu === undefined) {
        return missing(rule, ["CPU Typ integrované grafické karty"], values);
    }
    return igpu
        ? verdict(rule, "pass", "No graphics card, but the CPU has integrated graphics.", values)
        : verdict(
              rule,
              "fail",
              "No graphics card and the CPU has no integrated graphics — the PC would have no display output.",
              values
          );
}

/** Run every rule over a build. Order is stable (matches `RULE_TITLES`). */
export function checkBuild(parts: BuildParts, opts: { psuHeadroom?: number } = {}): RuleVerdict[] {
    return [
        checkCpuSocket(parts.cpu, parts.motherboard),
        checkRamMotherboard(parts.ram, parts.motherboard),
        checkRamCpu(parts.ram, parts.cpu),
        checkPsuWattage(parts, opts.psuHeadroom),
        checkGpuLength(parts.gpu, parts.case),
        checkCoolerClearance(parts.cooler, parts.case),
        checkCoolerSocket(parts.cooler, parts.cpu),
        checkMotherboardFormFactor(parts.motherboard, parts.case),
        checkPsuFormFactor(parts.psu, parts.case),
        checkDisplayOutput(parts.cpu, parts.gpu),
    ];
}

export type OverallVerdict = "compatible" | "incompatible" | "needs_review" | "no_conflicts_found";

/** Roles a build needs before "compatible" can be claimed (graphics are covered by the display_output rule). */
export const REQUIRED_BUILD_ROLES: readonly PcRole[] = ["cpu", "motherboard", "ram", "psu", "case"];

/**
 * `incompatible` if any rule fails; `needs_review` if any warns or is unknown;
 * `no_conflicts_found` when nothing failed but the build is incomplete
 * (`complete: false` — rules needing the missing parts were not applicable);
 * else `compatible`.
 */
export function overallVerdict(verdicts: RuleVerdict[], opts: { complete?: boolean } = {}): OverallVerdict {
    if (verdicts.some((v) => v.verdict === "fail")) {
        return "incompatible";
    }
    if (verdicts.some((v) => v.verdict === "warn" || v.verdict === "unknown")) {
        return "needs_review";
    }
    if (opts.complete === false) {
        return "no_conflicts_found";
    }
    return "compatible";
}

// ---------------------------------------------------------------------------
// Candidate-sourcing helpers (used by pc_build_suggest)
// ---------------------------------------------------------------------------

/**
 * Real Alza component categories (listing pages), live-verified 2026-10-06
 * via `list_categories` (Počítače a notebooky → Komponenty → …) and by
 * browsing each listing.
 */
export const PC_CATEGORY_IDS: Record<PcRole, number> = {
    cpu: 18842843, // Procesory
    motherboard: 18842832, // Základní desky
    ram: 18893268, // Paměti → DDR5 (DDR4: 18855197)
    gpu: 18842862, // Grafické karty
    storage: 18845887, // Disky a SSD → SSD
    case: 18849057, // Skříně a zdroje → Skříně
    cooler: 18842846, // Chlazení → Na procesory
    psu: 18849164, // Skříně a zdroje → Zdroje
};
export const RAM_CATEGORY_BY_TYPE: Record<string, number> = { DDR5: 18893268, DDR4: 18855197 };

/** Chipset → socket, for pre-filtering motherboard cards by name before a detail fetch. */
const CHIPSET_SOCKETS: Array<[RegExp, string]> = [
    [/\b(A620|B650E?|X670E?|B840|B850|X870E?)[A-Z]?\b/i, "AM5"],
    [/\b(A320|B350|X370|B450|X470|A520|B550|X570)[A-Z]?\b/i, "AM4"],
    [/\b(H610|B660|H670|Z690|B760|H770|Z790)[A-Z]?\b/i, "LGA1700"],
    [/\b(H810|B860|Z890)[A-Z]?\b/i, "LGA1851"],
    [/\b(TRX50|WRX90)\b/i, "TR5"],
];

export function socketHintFromBoardName(name: string): string | undefined {
    for (const [re, socket] of CHIPSET_SOCKETS) {
        if (re.test(name)) {
            return socket;
        }
    }
    return undefined;
}

/** Wattage from a PSU card name, when it carries one ("… 1000W", "750 W"). */
export function wattageHintFromName(name: string): number | undefined {
    const m = name.match(/\b(\d{3,4})\s?W\b/i);
    if (m) {
        return Number(m[1]);
    }
    // Model numbers carry the wattage too: "RM750x", "CX650M", "HX1000i".
    // Only round figures in the plausible PSU range count (not "ATX 3.1", "B650").
    for (const t of name.matchAll(/\b[A-Za-z]{1,5}[- ]?(\d{3,4})[A-Za-z]{0,3}\b/g)) {
        const w = Number(t[1]);
        if (w % 50 === 0 && w >= 300 && w <= 2000) {
            return w;
        }
    }
    return undefined;
}

/** Does a RAM card name advertise a multi-module kit (dual channel)? */
export function looksLikeRamKit(name: string): boolean {
    return /\bkit\b|dual[- ]?channel|\b[248]\s?[x×]\s?\d{1,3}\s?(?:GB|G)?\b/i.test(name);
}

/**
 * Order listing cards for one role: cards within `target` first (RAM kits
 * before single sticks, then most expensive = best part the money buys),
 * then over-target cards by ascending price. Cards above `hardCap` (the
 * money still left in the budget) are dropped: the budget is a hard limit.
 */
export function rankCandidates<T extends { name: string; price?: number }>(
    role: PcRole,
    cards: T[],
    target: number,
    hardCap = Infinity
): T[] {
    const priced = cards.filter((c) => c.price !== undefined && c.price <= hardCap);
    const kitFirst = (c: T) => (role === "ram" && looksLikeRamKit(c.name) ? 0 : 1);
    const within = priced
        .filter((c) => c.price! <= target)
        .sort((a, b) => kitFirst(a) - kitFirst(b) || b.price! - a.price!);
    const over = priced
        .filter((c) => c.price! > target)
        .sort((a, b) => kitFirst(a) - kitFirst(b) || a.price! - b.price!);
    return [...within, ...over];
}

/** Maximum cheaper-choice combinations `pc_build_suggest` tries when a later role cannot be filled. */
export const MAX_BACKTRACK_ATTEMPTS = 20;

/**
 * Bounded, deterministic backtracking plan. `levels` lists, per role, the
 * distinct candidate prices strictly below the greedy pick, most expensive
 * first (so level 0 = "next cheaper choice"). Returns up to `max` price caps
 * (a role absent from a cap object is unconstrained), cheapest total
 * downgrade first: one step down on one role before two steps, ties broken
 * in favour of the earlier role in `levels` (callers list gpu before cpu).
 */
export function backtrackCaps(
    levels: Partial<Record<PcRole, number[]>>,
    max = MAX_BACKTRACK_ATTEMPTS
): Array<Partial<Record<PcRole, number>>> {
    const roles = (Object.keys(levels) as PcRole[]).filter((r) => (levels[r]?.length ?? 0) > 0);
    const vectors: number[][] = [[]];
    for (const r of roles) {
        const n = levels[r]!.length;
        const next: number[][] = [];
        for (const v of vectors) {
            for (let step = 0; step <= n; step++) {
                next.push([...v, step]);
            }
        }
        vectors.splice(0, vectors.length, ...next);
    }
    const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
    const lexDesc = (a: number[], b: number[]) => {
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return b[i]! - a[i]!;
            }
        }
        return 0;
    };
    return vectors
        .filter((v) => sum(v) > 0)
        .sort((a, b) => sum(a) - sum(b) || lexDesc(a, b))
        .slice(0, max)
        .map((v) => {
            const caps: Partial<Record<PcRole, number>> = {};
            roles.forEach((r, i) => {
                if (v[i]! > 0) {
                    caps[r] = levels[r]![v[i]! - 1]!;
                }
            });
            return caps;
        });
}

export type BuildProfile = "gaming" | "workstation" | "office";

/** Budget share per role (sums to 1 over the roles the profile includes). */
export const BUDGET_SPLITS: Record<BuildProfile, Partial<Record<PcRole, number>>> = {
    gaming: { gpu: 0.38, cpu: 0.2, motherboard: 0.12, ram: 0.08, storage: 0.07, psu: 0.07, case: 0.05, cooler: 0.03 },
    workstation: {
        cpu: 0.3,
        gpu: 0.2,
        motherboard: 0.13,
        ram: 0.13,
        storage: 0.1,
        psu: 0.07,
        case: 0.04,
        cooler: 0.03,
    },
    office: { cpu: 0.3, motherboard: 0.2, ram: 0.15, storage: 0.15, psu: 0.08, case: 0.08, cooler: 0.04 },
};

/** Order in which suggest picks parts — each pick is constrained by the earlier ones. */
export const SUGGEST_ORDER: PcRole[] = ["cpu", "motherboard", "ram", "gpu", "storage", "case", "cooler", "psu"];

/**
 * Per-role allocations for a budget: fixed spend is subtracted first, the
 * rest split across the remaining roles by the profile's shares
 * (re-normalised so they sum to 1).
 */
export function allocateBudget(
    budget: number,
    profile: BuildProfile,
    roles: PcRole[],
    fixedSpend = 0
): Partial<Record<PcRole, number>> {
    const split = BUDGET_SPLITS[profile];
    const active = roles.filter((r) => (split[r] ?? 0) > 0);
    const sum = active.reduce((s, r) => s + (split[r] ?? 0), 0);
    const left = Math.max(0, budget - fixedSpend);
    const out: Partial<Record<PcRole, number>> = {};
    for (const r of active) {
        out[r] = Math.floor((left * (split[r] ?? 0)) / (sum || 1) + 1e-6);
    }
    return out;
}

/** Rules relevant to accepting a candidate for `role`, given the parts chosen so far. */
export function rulesForRole(role: PcRole): RuleId[] {
    switch (role) {
        case "cpu":
            return ["display_output"];
        case "motherboard":
            return ["cpu_socket_motherboard"];
        case "ram":
            return ["ram_motherboard", "ram_cpu"];
        case "gpu":
            return [];
        case "storage":
            return [];
        case "case":
            return ["gpu_length_case", "motherboard_form_factor_case"];
        case "cooler":
            return ["cooler_socket", "cooler_clearance_case"];
        case "psu":
            return ["psu_wattage", "psu_form_factor_case"];
    }
}
