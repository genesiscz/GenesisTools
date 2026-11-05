import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { ApiClient } from "@genesiscz/utils/api/ApiClient";
import { verifiedFetch, verifiedTls, verifiedTlsFor } from "@genesiscz/utils/net/verified-tls";

describe("verifiedTlsFor", () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-tls-"));
    const privateCa = join(dir, "private.pem");
    const extraCa = join(dir, "extra.pem");
    writeFileSync(privateCa, "PRIVATE");
    writeFileSync(extraCa, "EXTRA");

    it("leaves Bun's own trust store alone when there is no private CA", () => {
        expect(verifiedTlsFor({ caFiles: [], extraCaCertsFile: extraCa })).toEqual({ rejectUnauthorized: true });
    });

    it("lists the public roots and NODE_EXTRA_CA_CERTS before the private CAs, because a set ca replaces the store", () => {
        const { ca } = verifiedTlsFor({ caFiles: [privateCa], extraCaCertsFile: extraCa });

        expect(ca).toEqual([...rootCertificates, "EXTRA", "PRIVATE"]);
    });

    it("skips a NODE_EXTRA_CA_CERTS file that does not exist", () => {
        const { ca } = verifiedTlsFor({ caFiles: [privateCa], extraCaCertsFile: join(dir, "missing.pem") });

        expect(ca).toEqual([...rootCertificates, "PRIVATE"]);
    });

    it("ships no private CA, so the default keeps Bun's store and only forces verification", () => {
        expect(verifiedTls()).toEqual({ rejectUnauthorized: true });
    });
});

describe("verifiedFetch", () => {
    const realFetch = globalThis.fetch;
    const seen: unknown[] = [];

    afterEach(() => {
        globalThis.fetch = realFetch;
        seen.length = 0;
    });

    function recordTls(): void {
        globalThis.fetch = Object.assign(
            async (_input: string | URL | Request, init?: RequestInit) => {
                seen.push((init as { tls?: unknown } | undefined)?.tls);

                return new Response("ok");
            },
            { preconnect: realFetch.preconnect }
        );
    }

    it("passes verifiedTls() to Bun's fetch", async () => {
        recordTls();
        await verifiedFetch("https://invalid/");

        expect(seen).toEqual([verifiedTls()]);
    });

    it("is what ApiClient sends every request through", async () => {
        recordTls();
        await new ApiClient().getText("https://invalid/");

        expect(seen).toEqual([verifiedTls()]);
    });
});
