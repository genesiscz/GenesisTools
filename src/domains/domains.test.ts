import { describe, expect, it } from "bun:test";
import { parkingServiceFor } from "./lib/aftermarket";
import { mergeVerdicts } from "./lib/check";
import { parseDomain, seedWords } from "./lib/domain";
import { isPublicAddress } from "./lib/http";
import { interpretWhois, whoisFields } from "./lib/providers/whois";
import { pronounceability, scoreCandidate } from "./lib/score";
import { blend, dropVowels, shortForms } from "./lib/suggest/basic";
import { findHacks, hackSources } from "./lib/suggest/hacks";
import { findVibeHits } from "./lib/vibe";
import { changeReasons } from "./lib/watch";

describe("parseDomain", () => {
    it("splits label and TLD, folding case, scheme, path and www", () => {
        expect(parseDomain("https://www.GenesisTe.CH/path?q=1")).toEqual({
            domain: "genesiste.ch",
            label: "genesiste",
            tld: "ch",
        });
    });

    it("keeps second-level public suffixes together", () => {
        expect(parseDomain("shop.co.uk")?.tld).toBe("co.uk");
        expect(parseDomain("shop.co.uk")?.label).toBe("shop");
    });

    it("converts an IDN to punycode and keeps the unicode form", () => {
        const parsed = parseDomain("čez.cz");
        expect(parsed?.domain).toBe("xn--ez-dma.cz");
        expect(parsed?.unicode).toBe("čez.cz");
    });

    it("rejects bare words and invalid labels", () => {
        expect(parseDomain("genesis")).toBeNull();
        expect(parseDomain("-bad.com")).toBeNull();
        expect(parseDomain("a_b.com")).toBeNull();
    });

    it("rejects a subdomain, which no registry holds as a name of its own", () => {
        expect(parseDomain("blog.example.com")).toBeNull();
        expect(parseDomain("shop.example.co.uk")).toBeNull();
    });
});

describe("seedWords", () => {
    it("drops legal forms and folds diacritics", () => {
        expect(seedWords("Genesis Tech s.r.o.")).toEqual(["genesis", "tech"]);
        expect(seedWords("Žluťoučký Kůň a.s.")).toEqual(["zlutoucky", "kun"]);
    });
});

describe("domain hacks", () => {
    it("finds genesiste.ch and genes.is", () => {
        const tlds = ["ch", "is", "sh", "tech", "com"];
        const domains = hackSources(["genesis", "tech"]).flatMap((source) =>
            findHacks(source, tlds).map((h) => h.domain)
        );
        expect(domains).toContain("genesiste.ch");
        expect(domains).toContain("genes.is");
        expect(domains).toContain("genesis.tech");
    });

    it("slices by suffix length, never strips characters (rstrip turns trees into tr.es)", () => {
        expect(findHacks("trees", ["es"]).map((h) => h.domain)).toEqual(["tre.es"]);
        expect(findHacks("dress", ["es"])).toEqual([]);
    });

    it("respects the shortest label", () => {
        expect(findHacks("tech", ["ch"], 3)).toEqual([]);
        expect(findHacks("tech", ["ch"], 2).map((h) => h.domain)).toEqual(["te.ch"]);
    });
});

describe("short forms", () => {
    it("drops vowels after the first letter", () => {
        expect(dropVowels("genesis")).toBe("gnss");
    });

    it("blends overlapping words and concatenates the rest", () => {
        expect(blend("genesis", "sister")).toBe("genesister");
        expect(blend("genesis", "tech")).toBe("genesistech");
    });

    it("never returns the seed itself", () => {
        const forms = shortForms(["genesis", "tech"]);
        expect(forms).toContain("gentech");
        expect(forms).not.toContain("genesistech");
    });
});

describe("scoring", () => {
    it("prefers sayable labels", () => {
        expect(pronounceability("genetech")).toBeGreaterThan(pronounceability("gnsstch"));
    });

    it("ranks a cheap free hack above a long free affix name and far above a taken name", () => {
        const hack = { domain: "genesiste.ch", sources: ["hacks"] };
        const affix = { domain: "joingenesistech.com", sources: ["affixes"] };
        const free = { domain: "", provider: "x", verdicts: [], checkedAt: "", status: "available" as const };
        expect(scoreCandidate(hack, { ...free, domain: hack.domain })).toBeGreaterThan(
            scoreCandidate(affix, { ...free, domain: affix.domain })
        );
        expect(scoreCandidate(hack, { ...free, status: "taken" })).toBeLessThan(scoreCandidate(hack));
    });

    it("pulls a premium price down hard", () => {
        const candidate = { domain: "genesis.inc", sources: ["exact"] };
        const base = { domain: candidate.domain, provider: "vercel", verdicts: [], checkedAt: "" };
        const cheap = scoreCandidate(candidate, {
            ...base,
            status: "available",
            price: { registration: 15, currency: "USD", provider: "vercel" },
        });
        const premium = scoreCandidate(candidate, {
            ...base,
            status: "premium",
            price: { registration: 2499, currency: "USD", provider: "vercel" },
        });
        expect(cheap - premium).toBeGreaterThan(25);
    });
});

describe("mergeVerdicts", () => {
    it("lets a taken answer beat an available one", () => {
        const merged = mergeVerdicts("x.com", [
            { provider: "rdap", status: "available" },
            { provider: "dns", status: "taken", nameservers: ["ns1.example.net"] },
        ]);
        expect(merged.status).toBe("taken");
    });

    it("marks a taken name on parking nameservers as for sale", () => {
        const merged = mergeVerdicts("x.com", [
            { provider: "dns", status: "taken", nameservers: ["ns1.afternic.com", "ns2.afternic.com"] },
        ]);
        expect(merged.status).toBe("for-sale");
        expect(merged.detail).toBe("Afternic");
    });

    it("keeps the premium status and its price", () => {
        const price = { registration: 2499, currency: "USD", provider: "vercel", premium: true };
        const merged = mergeVerdicts("genesis.inc", [
            { provider: "dns", status: "unknown" },
            { provider: "vercel", status: "premium", price },
        ]);
        expect(merged.status).toBe("premium");
        expect(merged.price).toEqual(price);
    });

    it("says unknown when nobody decided", () => {
        expect(mergeVerdicts("x.zz", [{ provider: "dns", status: "unknown", detail: "no NS" }]).status).toBe("unknown");
    });
});

describe("parkingServiceFor", () => {
    it("matches host suffixes only", () => {
        expect(parkingServiceFor(["NS1.SEDOPARKING.COM."])).toBe("Sedo");
        expect(parkingServiceFor(["ns1.notsedoparking.com"])).toBeUndefined();
    });
});

describe("findVibeHits", () => {
    const lists = { en: ["shit", "ass"], cs: ["prdel", "pica"] };

    it("catches bereshit (reads 'bere shit' in Czech)", () => {
        expect(findVibeHits("bereshit", lists)).toEqual([{ languages: ["en"], word: "shit", position: "end" }]);
    });

    it("counts a 3-letter word only as the whole label", () => {
        expect(findVibeHits("class", lists)).toEqual([]);
        expect(findVibeHits("assets", lists)).toEqual([]);
        expect(findVibeHits("ass", lists)).toEqual([{ languages: ["en"], word: "ass", position: "whole" }]);
    });

    it("folds diacritics before matching", () => {
        expect(findVibeHits("Píča", lists)[0]?.word).toBe("pica");
    });
});

describe("WHOIS parsing", () => {
    const EU_FREE =
        "% EURid banner\n% says available or not, not found here\n\nDomain: x.eu\nScript: LATIN\nStatus: AVAILABLE\n";
    const EU_TAKEN = "% banner\nDomain: genesis.eu\n\nRegistrar:\n        Name: Internet.se Svenska AB\n";

    it("reads availability after stripping comment banners", () => {
        expect(interpretWhois(EU_FREE)).toBe("available");
        expect(interpretWhois(EU_TAKEN)).toBe("taken");
        expect(interpretWhois('No match for "X.COM".')).toBe("available");
    });

    it("treats a throttle reply as throttled, not available", () => {
        expect(interpretWhois("Query limit exceeded, try again later")).toBe("throttled");
        expect(interpretWhois(`% ${"terms of use ".repeat(80)}\nQuery limit exceeded`)).toBe("throttled");
    });

    it("needs registration evidence for taken; an empty or odd reply is unknown", () => {
        expect(interpretWhois("")).toBe("unknown");
        expect(interpretWhois("Access denied for your IP address.\n")).toBe("unknown");
        expect(interpretWhois("Domain Name: X.IO\nCreation Date: 2015-01-01T00:00:00Z\n")).toBe("taken");
    });

    it("reads a registry block as reserved", () => {
        expect(interpretWhois("Domain: nic.eu\nStatus: NOT ALLOWED\n")).toBe("reserved");
        expect(interpretWhois("This domain name is reserved by the registry.\n")).toBe("reserved");
    });

    it("reads registrar blocks, expiry and nameservers", () => {
        expect(whoisFields(EU_TAKEN).registrar).toBe("Internet.se Svenska AB");
        const gtld =
            "Registrar: NameCheap, Inc.\nRegistry Expiry Date: 2027-02-15T00:30:14Z\nName Server: A.DNS.PARK.IO\n";
        expect(whoisFields(gtld)).toEqual({
            registrar: "NameCheap, Inc.",
            expiresAt: "2027-02-15T00:30:14Z",
            nameservers: ["a.dns.park.io"],
        });
    });
});

describe("watch changeReasons", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const base = { domain: "x.com", provider: "rdap", verdicts: [], checkedAt: now.toISOString() };

    it("reports a name that became available", () => {
        const reasons = changeReasons({
            entry: { domain: "x.com", addedAt: "", lastStatus: "taken" },
            result: { ...base, status: "available" },
            now,
            expiryWarnDays: 45,
        });
        expect(reasons).toEqual(["taken -> available", "now available"]);
    });

    it("does not read an inconclusive check as a status change", () => {
        const reasons = changeReasons({
            entry: { domain: "x.com", addedAt: "", lastStatus: "taken" },
            result: { ...base, status: "unknown" },
            now,
            expiryWarnDays: 45,
        });
        expect(reasons).toEqual([]);
    });

    it("warns about a close expiry and stays quiet otherwise", () => {
        const soon = changeReasons({
            entry: { domain: "x.com", addedAt: "", lastStatus: "taken" },
            result: { ...base, status: "taken", expiresAt: "2026-11-01T12:00:00Z" },
            now,
            expiryWarnDays: 45,
        });
        expect(soon).toEqual(["expires in 15 days"]);

        const later = changeReasons({
            entry: { domain: "x.com", addedAt: "", lastStatus: "taken" },
            result: { ...base, status: "taken", expiresAt: "2027-11-01T12:00:00Z" },
            now,
            expiryWarnDays: 45,
        });
        expect(later).toEqual([]);
    });
});

describe("isPublicAddress", () => {
    it("refuses loopback, private, link-local and mapped private addresses", () => {
        for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1"]) {
            expect(isPublicAddress(address)).toBe(false);
        }

        for (const address of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
            expect(isPublicAddress(address)).toBe(false);
        }
    });

    it("accepts public addresses", () => {
        expect(isPublicAddress("93.184.216.34")).toBe(true);
        expect(isPublicAddress("2606:4700::1111")).toBe(true);
    });
});
