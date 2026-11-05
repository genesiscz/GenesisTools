import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { verifiedTls, verifiedTlsFor } from "@genesiscz/utils/net/verified-tls";

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
