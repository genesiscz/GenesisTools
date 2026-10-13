import { X509Certificate } from "node:crypto";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("net:ca-chain");

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The PEM certificates of a bundle, in order. */
export function pemCertificates(bundle: string): string[] {
    return bundle.match(PEM) ?? [];
}

function commonName(distinguishedName: string): string | null {
    return /(?:^|\n)CN=([^\n]+)/.exec(distinguishedName)?.[1]?.replace(/\\,/g, ",") ?? null;
}

/** Certificates of the macOS keychain search list whose common name matches. Empty elsewhere or on error. */
async function keychainCertificates(name: string): Promise<string[]> {
    if (process.platform !== "darwin") {
        return [];
    }

    const proc = Bun.spawn(["security", "find-certificate", "-a", "-c", name, "-p"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) {
        log.debug({ name, code }, "keychain has no certificate with that name");
        return [];
    }

    return pemCertificates(text);
}

/**
 * A private CA bundle completed up to its self-signed root. curl (LibreSSL) accepts a bundle that stops at an
 * intermediate CA; Bun's TLS (BoringSSL) does not and fails with "unable to get issuer certificate". On macOS
 * a missing issuer is looked up in the keychain (corporate roots are usually installed there) and matched by
 * its exact subject. Returns the bundle's certificates plus what was found; nothing is ever trusted blindly.
 */
export async function completeCaChain(bundle: string): Promise<string[]> {
    const chain = pemCertificates(bundle);
    const subjects = new Set(chain.map((pem) => new X509Certificate(pem).subject));
    for (let depth = 0; depth < 4; depth++) {
        const missing = [
            ...new Set(
                chain
                    .map((pem) => new X509Certificate(pem))
                    .filter((cert) => cert.issuer !== cert.subject && !subjects.has(cert.issuer))
                    .map((cert) => cert.issuer)
            ),
        ];
        if (missing.length === 0) {
            break;
        }

        let added = 0;
        for (const issuer of missing) {
            const name = commonName(issuer);
            if (!name) {
                continue;
            }

            for (const pem of await keychainCertificates(name)) {
                const cert = new X509Certificate(pem);
                if (cert.subject === issuer && !subjects.has(cert.subject)) {
                    chain.push(pem);
                    subjects.add(cert.subject);
                    added++;
                    log.info({ issuer: name }, "completed the CA bundle from the keychain");
                }
            }
        }

        if (added === 0) {
            break;
        }
    }

    return chain;
}
