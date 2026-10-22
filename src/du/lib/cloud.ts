// Cloud-backed content: File Provider domains (iCloud Drive, Desktop and
// Documents in iCloud, ~/Library/CloudStorage/<provider>) and dataless files.
// Opening a dataless file asks fileproviderd to download it, so by default the
// engines measure cloud-backed files from the listing alone (allocated size,
// never an open or an extent read) and report each folder they came from. These
// helpers mirror the C core (native/clonesize.c) for the Bun engine and the CLI.

import type { CloudBackedFolder, CloudBackedResult } from "./types";

/** st_flags bit of a dataless (cloud placeholder) file or folder. */
export const SF_DATALESS = 0x40000000;

/** The xattr every File Provider domain root carries. Its value is `<provider id>/<domain id>`. */
export const FP_DOMAIN_XATTR = "com.apple.file-provider-domain-id";

export const ICLOUD_PROVIDER = "com.apple.CloudDocs.iCloudDriveFileProvider";
export const TRESORIT_PROVIDER = "com.tresorit.mac.FileProvider";

/** The provider part of a domain-id xattr value. The domain part can hold an account name, so it is never kept. */
export function providerOf(domainId: string): string {
    const slash = domainId.indexOf("/");
    return slash < 0 ? domainId : domainId.slice(0, slash);
}

/** `~/Library/CloudStorage` and `~/Library/Mobile Documents`: skipped unless --include-cloud (is_cloud_root in C). */
export function isCloudRoot(dirpath: string, name: string): boolean {
    if (name !== "CloudStorage" && name !== "Mobile Documents") {
        return false;
    }

    return dirpath.endsWith("/Library");
}

/**
 * Where a File Provider domain root can sit: a child of a home folder (also under
 * /System/Volumes/Data), a child of `.../Library/CloudStorage`, and
 * `.../Library/Mobile Documents`. Only these children are asked for the xattr.
 */
export function isDomainCandidate(dirpath: string, name: string): boolean {
    if (dirpath.endsWith("/Library/CloudStorage")) {
        return true;
    }

    if (dirpath.endsWith("/Library") && name === "Mobile Documents") {
        return true;
    }

    const rest = dirpath.startsWith("/System/Volumes/Data") ? dirpath.slice(20) : dirpath;
    if (!rest.startsWith("/Users/")) {
        return false;
    }

    const user = rest.slice(7);
    return user.length > 0 && !user.includes("/");
}

export interface CloudDomain {
    path: string;
    provider: string;
}

/** The domain `dir` sits in: the longest known domain root that is `dir` or one of its ancestors. */
export function domainOf(dir: string, domains: CloudDomain[]): CloudDomain | null {
    let best: CloudDomain | null = null;
    for (const d of domains) {
        if (dir === d.path || dir.startsWith(`${d.path}/`)) {
            if (!best || d.path.length > best.path.length) {
                best = d;
            }
        }
    }

    return best;
}

/** One bucket per domain root, plus one per folder holding stray dataless files. */
export function emptyFolder(path: string, domain: CloudDomain | null): CloudBackedFolder {
    return {
        path,
        domain: domain !== null,
        provider: domain?.provider ?? "",
        files: 0,
        dataless_files: 0,
        dataless_dirs: 0,
        local_bytes: 0,
        cloud_only_bytes: 0,
    };
}

export function mergeCloudFolders(lists: CloudBackedFolder[][]): CloudBackedFolder[] {
    const byPath = new Map<string, CloudBackedFolder>();
    for (const list of lists) {
        for (const f of list) {
            const have = byPath.get(f.path);
            if (!have) {
                byPath.set(f.path, { ...f });
                continue;
            }

            have.files += f.files;
            have.dataless_files += f.dataless_files;
            have.dataless_dirs += f.dataless_dirs;
            have.local_bytes += f.local_bytes;
            have.cloud_only_bytes += f.cloud_only_bytes;
        }
    }

    return [...byPath.values()].filter((f) => f.files > 0 || f.dataless_dirs > 0);
}

export function cloudBackedFrom(opts: {
    folders: CloudBackedFolder[];
    includeCloud: boolean;
    guard: boolean;
}): CloudBackedResult {
    const sum = (k: "files" | "dataless_files" | "dataless_dirs" | "local_bytes" | "cloud_only_bytes"): number =>
        opts.folders.reduce((acc, f) => acc + f[k], 0);
    return {
        mode: opts.includeCloud ? "opened" : "stat-only",
        materialize_guard: !opts.includeCloud && opts.guard,
        files: sum("files"),
        dataless_files: sum("dataless_files"),
        dataless_dirs: sum("dataless_dirs"),
        local_bytes: sum("local_bytes"),
        cloud_only_bytes: sum("cloud_only_bytes"),
        folders: opts.folders,
    };
}
