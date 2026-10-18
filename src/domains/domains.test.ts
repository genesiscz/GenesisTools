import { describe, expect, it } from "bun:test";
import { fetchLanding, type LandingNetwork, marketplaceForUrl, parkingServiceFor } from "./lib/aftermarket";
import { mergeVerdicts } from "./lib/check";
import { parseDomain, seedWords } from "./lib/domain";
import { type HttpResponse, isPublicAddress, pickPublicAddress, request } from "./lib/http";
import { interpretWhois, whoisFields } from "./lib/providers/whois";
import { pronounceability, scoreCandidate } from "./lib/score";
import { effectivePrice, withinBudget } from "./lib/search";
import { blend, dropVowels, shortForms } from "./lib/suggest/basic";
import { findHacks, hackSources } from "./lib/suggest/hacks";
import { findVibeHits } from "./lib/vibe";
import { applyObservations, changeReasons, type WatchChange } from "./lib/watch";

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

    it("finds a marketplace by the final URL's host, never by a substring or on the marketplace itself", () => {
        expect(marketplaceForUrl("https://www.afternic.com/forsale/x.com", "x.com")).toBe("Afternic");
        expect(marketplaceForUrl("https://sedo.com/search/details/?domain=x.com", "x.com")).toBe("Sedo");
        expect(marketplaceForUrl("https://sedo.com/", "x.com")).toBeUndefined();
        expect(marketplaceForUrl("https://hefty.com/", "hefty.com")).toBeUndefined();
        expect(marketplaceForUrl("https://blog.example/?ref=afternic.com", "blog.example")).toBeUndefined();
        expect(marketplaceForUrl("https://www.hugedomains.com/", "hugedomains.com")).toBeUndefined();
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

    it("ignores a word inside an innocent one, but not beside it", () => {
        const en = { en: ["anal", "crap", "shit"] };
        expect(findVibeHits("dataanalytics", en)).toEqual([]);
        expect(findVibeHits("canal", en)).toEqual([]);
        expect(findVibeHits("scrapshit", en).map((hit) => hit.word)).toEqual(["shit"]);
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

    it("reads a refusal as throttled even when it says no information is available", () => {
        expect(interpretWhois("Query limit exceeded; no information available; try again later\n")).toBe("throttled");
        expect(interpretWhois("% Query limit exceeded\nNo information available\n")).toBe("throttled");
    });

    it("ignores throttle words in the terms of use after the answer", () => {
        const terms = "Terms of Use: Queries are throttled. If too many queries are received, try again later.\r\n";
        expect(interpretWhois(`Domain not found.\r\n>>> Last update of WHOIS database <<<\r\n\r\n${terms}`)).toBe(
            "available"
        );
        expect(interpretWhois(`Domain Name: x.io\r\nRegistrar: Example Inc.\r\n>>> Last update <<<\r\n${terms}`)).toBe(
            "taken"
        );
    });

    it("ignores throttle words in commented terms after the answer, but not in a banner before it", () => {
        const footer = "% Terms of Use: too many queries may cause access to be blocked\n";
        expect(interpretWhois(`Domain not found.\n${footer}`)).toBe("available");
        expect(interpretWhois(`Domain Name: x.io\nRegistrar: Example Inc.\n${footer}`)).toBe("taken");
        expect(interpretWhois(`% Terms and Conditions of Use\n% Query limit exceeded\nDomain not found.\n`)).toBe(
            "throttled"
        );
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

    it("keeps warning about a saved expiry while the name stays registered", () => {
        const entry = { domain: "x.com", addedAt: "", lastStatus: "taken" as const, expiresAt: "2026-11-01T12:00:00Z" };
        expect(changeReasons({ entry, result: { ...base, status: "taken" }, now, expiryWarnDays: 45 })).toEqual([
            "expires in 15 days",
        ]);
        expect(changeReasons({ entry, result: { ...base, status: "available" }, now, expiryWarnDays: 45 })).toEqual([
            "taken -> available",
            "now available",
        ]);
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

        for (const address of [
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::ffff:c0a8:101",
            "::7f00:1",
        ]) {
            expect(isPublicAddress(address)).toBe(false);
        }
    });

    it("judges a NAT64 address by the IPv4 address inside it", () => {
        expect(isPublicAddress("64:ff9b::a00:1")).toBe(false);
        expect(isPublicAddress("64:ff9b::10.0.0.1")).toBe(false);
        expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
    });

    it("accepts public addresses", () => {
        expect(isPublicAddress("93.184.216.34")).toBe(true);
        expect(isPublicAddress("2606:4700::1111")).toBe(true);
    });
});

describe("fetchLanding", () => {
    const DNS: Record<string, string[]> = {
        "a.example": ["93.184.216.34"],
        "b.example": ["2606:4700::1111"],
        "evil.example": ["93.184.216.34", "10.0.0.5"],
    };
    const reply = (status: number, location?: string): HttpResponse<unknown> => ({
        status,
        url: "",
        body: null,
        text: "",
        headers: new Headers(location ? { location } : {}),
    });

    function network(redirects: Record<string, string>) {
        const sent: { url: string; init: Parameters<LandingNetwork["send"]>[1] }[] = [];
        const net: LandingNetwork = {
            // The real rule on a fake DNS table; an IP literal resolves to itself, as in resolvePublicAddress.
            resolve: async (host) => pickPublicAddress(host, DNS[host] ?? [host.replace(/^\[|\]$/g, "")]),
            send: async (url, init) => {
                sent.push({ url, init });
                const location = redirects[url];
                return location ? reply(302, location) : reply(200);
            },
        };
        return { net, sent };
    }

    it("pins every hop to the checked address and keeps the real host for Host and TLS", async () => {
        const { net, sent } = network({ "https://93.184.216.34/": "https://b.example/x" });
        const response = await fetchLanding("https://a.example/", net);
        expect(response.url).toBe("https://b.example/x");
        expect(sent.map((entry) => entry.url)).toEqual(["https://93.184.216.34/", "https://[2606:4700::1111]/x"]);
        expect(sent[1].init?.headers).toMatchObject({ host: "b.example" });
        expect(sent[1].init?.tls?.serverName).toBe("b.example");
        expect(sent[1].init?.redirect).toBe("manual");
    });

    it("never sends to a private destination, whatever its spelling", async () => {
        for (const target of [
            "http://evil.example/",
            "http://127.0.0.1/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:7f00:1]/",
            "http://[::1]:8080/",
        ]) {
            const { net, sent } = network({ "https://93.184.216.34/": target });
            await expect(fetchLanding("https://a.example/", net)).rejects.toThrow("non-public");
            expect(sent).toHaveLength(1);
        }
    });

    it("refuses a non-http redirect and a redirect loop", async () => {
        const toFile = network({ "https://93.184.216.34/": "file:///etc/passwd" });
        await expect(fetchLanding("https://a.example/", toFile.net)).rejects.toThrow("refused");

        const loop = network({ "https://93.184.216.34/": "https://a.example/" });
        await expect(fetchLanding("https://a.example/", loop.net)).rejects.toThrow("redirects");
        expect(loop.sent).toHaveLength(6);
    });
});

describe("search price ceiling", () => {
    const at = (domain: string, registration?: number) => ({
        domain,
        provider: "rdap",
        verdicts: [],
        checkedAt: "2026-10-18T00:00:00Z",
        status: "available" as const,
        ...(registration === undefined
            ? {}
            : { price: { registration, renewal: registration, currency: "USD", provider: "vercel" } }),
    });
    const estimates = new Map([["cz", { registration: 9, renewal: 9, currency: "USD", provider: "porkbun" }]]);

    it("prices an unquoted name by its TLD list price", () => {
        expect(effectivePrice(at("genesis.cz"), estimates)?.registration).toBe(9);
        expect(effectivePrice(at("genesis.cz", 25), estimates)?.registration).toBe(25);
        expect(effectivePrice(at("genesis.xyz"), estimates)).toBeUndefined();
    });

    it("keeps a name under the ceiling and drops one with no price at all", () => {
        expect(withinBudget(at("genesis.cz"), estimates, 10)).toBe(true);
        expect(withinBudget(at("genesis.cz"), estimates, 5)).toBe(false);
        expect(withinBudget(at("genesis.cz", 25), estimates, 10)).toBe(false);
        expect(withinBudget(at("genesis.xyz"), estimates, 1000)).toBe(false);
        expect(withinBudget(at("genesis.xyz"), estimates)).toBe(true);
    });
});

describe("request maxBytes", () => {
    it("reads only the first bytes of a large body and never reads a manual redirect's body", async () => {
        const cancelled = Promise.withResolvers<true>();
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                if (new URL(req.url).pathname === "/redirect") {
                    return new Response("x".repeat(10_000), { status: 302, headers: { location: "/" } });
                }

                // An endless stream: the test only finishes if the reader stops and cancels it.
                const stream = new ReadableStream({
                    pull(controller) {
                        controller.enqueue(new TextEncoder().encode("é".repeat(1000)));
                    },
                    cancel() {
                        cancelled.resolve(true);
                    },
                });
                return new Response(stream);
            },
        });

        try {
            const page = await request(`http://127.0.0.1:${server.port}/`, { maxBytes: 4001 });
            // 2 bytes per "é": 4001 bytes are 2000 whole characters and half of one, dropped by the decoder.
            expect(page.text.startsWith("é".repeat(2000))).toBe(true);
            expect(page.text.length).toBeLessThanOrEqual(2001);
            // The server learns of the cancel asynchronously: wait for that event, with a deadline only as a backstop.
            const deadline = new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000).unref());
            expect(await Promise.race([cancelled.promise, deadline])).toBe(true);

            const hop = await request(`http://127.0.0.1:${server.port}/redirect`, {
                redirect: "manual",
                maxBytes: 4001,
            });
            expect(hop.status).toBe(302);
            expect(hop.text).toBe("");
        } finally {
            server.stop(true);
        }
    });
});

describe("mergeVerdicts precedence", () => {
    it("lets a registry block beat an available answer", () => {
        const merged = mergeVerdicts("x.com", [
            { provider: "rdap", status: "available" },
            { provider: "whois", status: "reserved" },
        ]);
        expect(merged.status).toBe("reserved");
    });
});

describe("watch applyObservations", () => {
    const result = (status: "taken" | "available", checkedAt: string) => ({
        domain: "x.com",
        provider: "rdap",
        verdicts: [],
        checkedAt,
        status,
    });
    const change = (addedAt: string, status: "taken" | "available", checkedAt: string): WatchChange => ({
        entry: { domain: "x.com", addedAt },
        result: result(status, checkedAt),
        reasons: [],
    });

    it("keeps the newer refresh when an older one finishes last", () => {
        const watch = [{ domain: "x.com", addedAt: "a" }];
        const newer = applyObservations(
            watch,
            [change("a", "available", "2026-10-18T10:05:00Z")],
            "2026-10-18T10:04:00Z"
        );
        const older = applyObservations(watch, [change("a", "taken", "2026-10-18T10:06:00Z")], "2026-10-18T10:00:00Z");
        expect(watch[0]).toMatchObject({ lastStatus: "available", observedAt: "2026-10-18T10:04:00Z" });
        // The losing refresh reports nothing, so it cannot raise an alert about a state it did not store.
        expect(newer).toHaveLength(1);
        expect(older).toEqual([]);
    });

    it("skips an entry that was removed and added again during the refresh", () => {
        const watch = [{ domain: "x.com", addedAt: "b" }];
        expect(
            applyObservations(watch, [change("a", "taken", "2026-10-18T10:05:00Z")], "2026-10-18T10:04:00Z")
        ).toEqual([]);
        expect(watch[0]).toEqual({ domain: "x.com", addedAt: "b" });
    });
});
