import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * libcurl-impersonate (github.com/lexiforest/curl-impersonate, MIT): the patched libcurl + BoringSSL that curl_cffi
 * wraps. Pinned per platform by the sha256 GitHub publishes for each release asset; bump all of them together.
 */
const VERSION = "2.3.2";
const RELEASE_URL = `https://github.com/lexiforest/curl-impersonate/releases/download/v${VERSION}`;

interface PlatformAsset {
    triple: string;
    sha256: string;
    /** The member of the archive that is the shared library to load. */
    library: string;
}

const ASSETS: Record<string, PlatformAsset> = {
    "darwin-arm64": {
        triple: "arm64-macos",
        sha256: "6c0dc841a8f6b7a8f81a0f55197e8241405fb7dcd97df180e66fc6f796c42bd5",
        library: "libcurl-impersonate.4.8.0.dylib",
    },
    "darwin-x64": {
        triple: "x86_64-macos",
        sha256: "eed3342d8768065ab7a9106f4286d9101959b7e9e1b2b969eb8d8be1a52422cd",
        library: "libcurl-impersonate.4.8.0.dylib",
    },
    "linux-x64": {
        triple: "x86_64-linux-gnu",
        sha256: "7716be1ec87f13ecc776c211003bd1122c345287829b1f18a494a5467c90ab1e",
        library: "libcurl-impersonate.so.4.8.0",
    },
    "linux-arm64": {
        triple: "aarch64-linux-gnu",
        sha256: "1cb74a3b5103df020c252f9efef5a779c87380ee6244b365a90a0e4f7086864e",
        library: "libcurl-impersonate.so.4.8.0",
    },
};

export interface LibcurlImpersonateFiles {
    /** The shared library for `dlopen`. */
    library: string;
    /** PEM bundle of the Mozilla roots Bun ships; BoringSSL has no access to the system trust store. */
    caBundle: string;
}

let resolved: Promise<LibcurlImpersonateFiles> | undefined;

/** Downloads the pinned library on first use (about 7-28 MB per platform), then answers from disk. */
export function ensureLibcurlImpersonate(): Promise<LibcurlImpersonateFiles> {
    resolved ??= install().catch((error: unknown) => {
        resolved = undefined;
        throw error;
    });
    return resolved;
}

async function install(): Promise<LibcurlImpersonateFiles> {
    const key = `${process.platform}-${process.arch}`;
    const asset = ASSETS[key];
    if (!asset) {
        throw new Error(
            `libcurl-impersonate has no shared library for ${key} (v${VERSION} publishes none for Windows). ` +
                `Supported: ${Object.keys(ASSETS).join(", ")}`
        );
    }

    const dir = toolDataDir("impersonate", `libcurl-impersonate-${VERSION}`);
    const library = join(dir, asset.library.split("/").pop() ?? asset.library);
    const caBundle = writeCaBundle(dir);
    if (existsSync(library)) {
        return { library, caBundle };
    }

    mkdirSync(dir, { recursive: true });
    const url = `${RELEASE_URL}/libcurl-impersonate-v${VERSION}.${asset.triple}.tar.gz`;
    logger.info({ url, dir }, "downloading libcurl-impersonate");
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`libcurl-impersonate download failed: HTTP ${response.status} for ${url}`);
    }

    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== asset.sha256) {
        throw new Error(`libcurl-impersonate checksum mismatch for ${url}: got ${digest}, pinned ${asset.sha256}`);
    }

    // tar reads the archive from stdin into a staging folder, so no archive copy is left on disk.
    const staging = join(dir, `.staging-${process.pid}-${Date.now()}`);
    mkdirSync(staging, { recursive: true });
    const tar = Bun.spawnSync(["tar", "-xzf", "-", "-C", staging, asset.library], { stdin: archive, stderr: "pipe" });
    if (tar.exitCode !== 0) {
        throw new Error(`tar could not extract ${asset.library} from ${url}: ${tar.stderr.toString().trim()}`);
    }

    // Rename into place last, so a second process never loads a half-written library.
    renameSync(join(staging, asset.library), library);
    rmdirSync(staging);
    logger.info({ library }, "libcurl-impersonate installed");
    return { library, caBundle };
}

function writeCaBundle(dir: string): string {
    const pem = `${tls.rootCertificates.join("\n")}\n`;
    const path = join(dir, `ca-${createHash("sha256").update(pem).digest("hex").slice(0, 12)}.pem`);
    if (!existsSync(path) || readFileSync(path, "utf8") !== pem) {
        mkdirSync(dir, { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, pem);
        renameSync(temp, path);
    }

    return path;
}
