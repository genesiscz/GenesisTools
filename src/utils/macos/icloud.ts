import { getDarwinKit } from "./darwinkit";
import type {
    ICloudDirEntry,
    ICloudListDirResult,
    ICloudOkResult,
    ICloudReadResult,
    ICloudStatusResult,
} from "./types";

/**
 * Check iCloud Drive availability and container URL.
 */
export async function icloudStatus(): Promise<ICloudStatusResult> {
    return getDarwinKit().icloud.status();
}

/**
 * Read a text file from iCloud Drive.
 * @param path - Relative path within the iCloud container
 */
export async function icloudRead(path: string): Promise<ICloudReadResult> {
    return getDarwinKit().icloud.read({ path });
}

/**
 * Write a text file to iCloud Drive.
 */
export async function icloudWrite(path: string, content: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.write({ path, content });
}

/**
 * Write binary data (base64-encoded) to iCloud Drive.
 */
export async function icloudWriteBytes(path: string, data: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.writeBytes({ path, data });
}

/**
 * Delete a file from iCloud Drive.
 */
export async function icloudDelete(path: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.delete({ path });
}

/**
 * Move/rename a file in iCloud Drive.
 */
export async function icloudMove(source: string, destination: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.move({ source, destination });
}

/**
 * Copy a file in iCloud Drive.
 */
export async function icloudCopy(source: string, destination: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.copyFile({ source, destination });
}

/**
 * List directory contents in iCloud Drive.
 */
export async function icloudList(path: string): Promise<ICloudDirEntry[]> {
    const result: ICloudListDirResult = await getDarwinKit().icloud.listDir({ path });
    return result.entries;
}

/**
 * Create a directory in iCloud Drive (recursive).
 */
export async function icloudMkdir(path: string): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.ensureDir({ path });
}

/**
 * Start monitoring iCloud Drive for file changes.
 * Use `getDarwinKit().icloud.onFilesChanged(handler)` to listen for changes.
 */
export async function icloudStartMonitoring(): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.startMonitoring();
}

/**
 * Stop monitoring iCloud Drive for file changes.
 */
export async function icloudStopMonitoring(): Promise<ICloudOkResult> {
    return getDarwinKit().icloud.stopMonitoring();
}

/**
 * Subscribe to iCloud Drive file change notifications.
 * Call icloudStartMonitoring() first to begin receiving events.
 * @returns Unsubscribe function
 */
export function onIcloudFilesChanged(handler: (notification: { paths: string[] }) => void): () => void {
    return getDarwinKit().icloud.onFilesChanged(handler);
}
