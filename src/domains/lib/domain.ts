import { domainToASCII, domainToUnicode } from "node:url";
import type { ParsedDomain } from "@app/domains/lib/types";

/**
 * Second-level public suffixes people actually register under. Not the whole Public Suffix List:
 * enough that `foo.co.uk` splits as `foo` + `co.uk` instead of `foo.co` + `uk`.
 */
const MULTI_LABEL_SUFFIXES = new Set([
    "co.uk",
    "org.uk",
    "me.uk",
    "ltd.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "co.jp",
    "co.kr",
    "com.br",
    "com.mx",
    "com.ar",
    "com.tr",
    "com.cn",
    "com.tw",
    "com.hk",
    "com.sg",
    "co.in",
    "co.za",
    "co.il",
    "com.pl",
    "com.ua",
]);

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function parseDomain(input: string): ParsedDomain | null {
    const trimmed = input
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/\.$/, "")
        .replace(/^www\./, "");

    if (!trimmed.includes(".")) {
        return null;
    }

    const ascii = domainToASCII(trimmed);
    if (!ascii) {
        return null;
    }

    const labels = ascii.split(".");
    if (labels.some((label) => !LABEL_RE.test(label))) {
        return null;
    }

    const lastTwo = labels.slice(-2).join(".");
    const tldLabels = labels.length > 2 && MULTI_LABEL_SUFFIXES.has(lastTwo) ? 2 : 1;
    const tld = labels.slice(-tldLabels).join(".");
    const label = labels.slice(0, -tldLabels).join(".");
    if (!label) {
        return null;
    }

    const unicode = domainToUnicode(ascii);
    return { domain: ascii, label, tld, ...(unicode !== ascii ? { unicode } : {}) };
}

export function tldOf(domain: string): string {
    return parseDomain(domain)?.tld ?? domain.split(".").pop() ?? "";
}

/** Strip a TLD list entry to its bare form: ".Com " -> "com". */
export function normalizeTld(tld: string): string {
    return tld.trim().toLowerCase().replace(/^\./, "");
}

/** Lowercase with diacritics removed: "Žluťoučký" -> "zlutoucky". */
export function foldAscii(text: string): string {
    return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Turn free text ("Genesis Tech s.r.o.") into words and a joined label ("genesistech").
 * Legal-form suffixes and punctuation are dropped; diacritics are folded to ASCII.
 */
export function seedWords(seed: string): string[] {
    const folded = foldAscii(seed);

    const LEGAL_FORMS = new Set(["sro", "s.r.o", "s.r.o.", "as", "a.s.", "inc", "llc", "ltd", "gmbh", "corp", "co"]);
    return folded
        .split(/[\s_,]+/)
        .map((word) => word.replace(/[^a-z0-9.-]/g, ""))
        .filter((word) => word.length > 0 && !LEGAL_FORMS.has(word))
        .map((word) => word.replace(/[^a-z0-9-]/g, ""))
        .filter((word) => word.length > 0);
}

export function isValidLabel(label: string): boolean {
    return LABEL_RE.test(label);
}
