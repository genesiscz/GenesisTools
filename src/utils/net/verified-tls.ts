import { existsSync, readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { env } from "@genesiscz/utils/env";
import { privateCaFiles } from "@genesiscz/utils/net/private-ca";

/** The `tls` option of Bun's `fetch`: verification always on, plus a trust store when private CAs are added. */
export interface VerifiedTls {
    ca?: string[];
    rejectUnauthorized: true;
}

export interface VerifiedTlsOptions {
    caFiles: string[];
    extraCaCertsFile?: string;
}

/**
 * `rejectUnauthorized` is explicit because `NODE_TLS_REJECT_UNAUTHORIZED=0` anywhere in the process otherwise
 * turns verification off. A set `ca` replaces Bun's whole trust store, `NODE_EXTRA_CA_CERTS` included, so the
 * list repeats the public roots and that file before the private CA files.
 */
export function verifiedTlsFor({ caFiles, extraCaCertsFile }: VerifiedTlsOptions): VerifiedTls {
    if (caFiles.length === 0) {
        return { rejectUnauthorized: true };
    }

    const extra = extraCaCertsFile && existsSync(extraCaCertsFile) ? [readFileSync(extraCaCertsFile, "utf8")] : [];

    return {
        ca: [...rootCertificates, ...extra, ...caFiles.map((file) => readFileSync(file, "utf8"))],
        rejectUnauthorized: true,
    };
}

let processTls: VerifiedTls | undefined;

/** `verifiedTlsFor` with this install's `privateCaFiles()` and `NODE_EXTRA_CA_CERTS`, read once per process. */
export function verifiedTls(): VerifiedTls {
    processTls ??= verifiedTlsFor({ caFiles: privateCaFiles(), extraCaCertsFile: env.node.getExtraCaCerts() });

    return processTls;
}

/** Bun's `fetch` with `verifiedTls()`, for a caller that cannot pass Bun's `tls` option itself (ofetch, a client). */
export const verifiedFetch: typeof fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, tls: verifiedTls() }),
    { preconnect: fetch.preconnect }
);
