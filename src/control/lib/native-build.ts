import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const REQUIRED_SOURCES = ["Package.swift", "Sources", "SnapshotSupport"] as const;
const RECEIPT_VERSION = 1;

interface NativeSourceFile {
    path: string;
    hash: string;
}

export interface NativeSourceSnapshot {
    files: NativeSourceFile[];
    fingerprint: string;
}

interface NativeBuildReceipt {
    version: number;
    sources: NativeSourceSnapshot;
    binary: string;
}

function hash(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function receiptPath(binary: string): string {
    return join(dirname(binary), ".native-build-receipt.json");
}

function sourceFiles(sourceDir: string): string[] {
    const roots = REQUIRED_SOURCES.map((path) => join(sourceDir, path));
    if (
        !existsSync(roots[0]!) ||
        !statSync(roots[0]!).isFile() ||
        roots.slice(1).some((path) => !existsSync(path) || !statSync(path).isDirectory())
    ) {
        throw new Error("native source roots are missing");
    }

    const files = [roots[0]!];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                visit(path);
            } else if (path.endsWith(".swift")) {
                files.push(path);
            }
        }
    };
    visit(roots[1]!);
    visit(roots[2]!);
    return files.sort();
}

function binarySignature(binary: string): string {
    if (!existsSync(binary) || !statSync(binary).isFile()) {
        throw new Error("native binary is missing");
    }
    return hash(readFileSync(binary));
}

function isReceipt(value: unknown): value is NativeBuildReceipt {
    if (!value || typeof value !== "object") {
        return false;
    }
    const receipt = value as Partial<NativeBuildReceipt>;
    return (
        receipt.version === RECEIPT_VERSION &&
        typeof receipt.binary === "string" &&
        !!receipt.sources &&
        typeof receipt.sources.fingerprint === "string" &&
        Array.isArray(receipt.sources.files)
    );
}

export function captureNativeSources(sourceDir: string): NativeSourceSnapshot {
    const files = sourceFiles(sourceDir).map((path) => ({
        path: relative(sourceDir, path),
        hash: hash(readFileSync(path)),
    }));
    return { files, fingerprint: hash(SafeJSON.stringify(files)) };
}

export function recordNativeBuild({
    binary,
    sourceDir,
    before,
}: {
    binary: string;
    sourceDir: string;
    before: NativeSourceSnapshot;
}): void {
    const after = captureNativeSources(sourceDir);
    if (after.fingerprint !== before.fingerprint) {
        throw new Error("native sources changed during build; receipt not recorded");
    }
    const receipt: NativeBuildReceipt = { version: RECEIPT_VERSION, sources: after, binary: binarySignature(binary) };
    const path = receiptPath(binary);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, SafeJSON.stringify(receipt));
    renameSync(temporary, path);
}

export function nativeNeedsBuild({ binary, sourceDir }: { binary: string; sourceDir: string }): boolean {
    try {
        const sources = captureNativeSources(sourceDir);
        const path = receiptPath(binary);
        if (!existsSync(path)) {
            return true;
        }
        const receipt = SafeJSON.parse(readFileSync(path, "utf-8")) as unknown;
        return (
            !isReceipt(receipt) ||
            receipt.sources.fingerprint !== sources.fingerprint ||
            receipt.binary !== binarySignature(binary)
        );
    } catch (error) {
        logger.debug({ error, sourceDir }, "native build receipt is unavailable or stale");
        return true;
    }
}
