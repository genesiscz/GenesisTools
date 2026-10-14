/**
 * What one process has open, on every platform (see `processes.ts` for the rule): libproc on macOS, `/proc/<pid>`
 * on Linux, CIM handle counts on Windows. Only this user's processes are readable on macOS and Linux.
 */
import { statSync } from "node:fs";
import { readProcessCwd } from "./cwd";
import { readProcessPath } from "./libproc-table";
import {
    countProcFds,
    listProcFds,
    readProcCwd,
    readProcExe,
    readProcTcp,
    readProcUdp,
    TCP_STATE_NAMES,
} from "./linux-proc";
import { darwinKernel, processPlatform } from "./os";
import { countOpenFds, listOpenFileEntries } from "./socket-owner";
import { listCimProcesses } from "./windows-cim";

export interface OpenFile {
    /** lsof's FD column: `cwd`, `txt`, or the descriptor with its mode letter (`3u`). */
    fd: string;
    /** lsof's TYPE column: `DIR`, `REG`, `CHR`, `FIFO`, `IPv4`, `IPv6`, `unix`, `PIPE`, `KQUEUE`, `sock`, … */
    type: string;
    /** lsof's NAME column: a path, `TCP 127.0.0.1:3000->127.0.0.1:51000 (ESTABLISHED)`, or empty. */
    name: string;
}

const FILE_TYPES = new Map([
    [0x1000, "FIFO"],
    [0x2000, "CHR"],
    [0x4000, "DIR"],
    [0x6000, "BLK"],
    [0x8000, "REG"],
    [0xa000, "LINK"],
    [0xc000, "SOCK"],
]);

function linuxFileType(path: string): string {
    try {
        return FILE_TYPES.get(statSync(path).mode & 0xf000) ?? "REG";
    } catch {
        return "REG";
    }
}

function linuxOpenFiles(pid: number): OpenFile[] | null {
    const fds = listProcFds(pid);

    if (fds === null) {
        return null;
    }

    const inet = new Map(
        [
            ...readProcTcp().map((row) => ({ row, protocol: "TCP" })),
            ...readProcUdp().map((row) => ({ row, protocol: "UDP" })),
        ].map(({ row, protocol }) => [row.inode, { row, protocol }])
    );
    const files: OpenFile[] = [];
    const cwd = readProcCwd(pid);
    const exe = readProcExe(pid);

    if (cwd !== null) {
        files.push({ fd: "cwd", type: "DIR", name: cwd });
    }

    if (exe !== null) {
        files.push({ fd: "txt", type: "REG", name: exe });
    }

    for (const { fd, target, mode } of fds) {
        const socket = target.match(/^socket:\[(\d+)\]$/);
        const label = `${fd}${mode}`;

        if (socket) {
            const found = inet.get(Number(socket[1]));

            if (found) {
                const { row, protocol } = found;
                const v6 = row.localAddress.includes(":");
                const end = (address: string, port: number) =>
                    `${address === "0.0.0.0" || address === "::" ? "*" : v6 ? `[${address}]` : address}:${port}`;
                const remote = row.remotePort === 0 ? "" : `->${end(row.remoteAddress, row.remotePort)}`;
                const state = protocol === "TCP" ? ` (${TCP_STATE_NAMES[row.state] ?? "UNKNOWN"})` : "";
                files.push({
                    fd: label,
                    type: v6 ? "IPv6" : "IPv4",
                    name: `${protocol} ${end(row.localAddress, row.localPort)}${remote}${state}`,
                });
            } else {
                files.push({ fd: label, type: "sock", name: "" });
            }

            continue;
        }

        if (target.startsWith("pipe:")) {
            files.push({ fd: label, type: "FIFO", name: "pipe" });
        } else if (target.startsWith("anon_inode:")) {
            files.push({ fd: label, type: "a_inode", name: target.slice("anon_inode:".length) });
        } else {
            files.push({ fd: label, type: linuxFileType(target), name: target });
        }
    }

    return files;
}

/**
 * The open files of a process as `lsof -p <pid>` lists them: the working directory, the executable, then every
 * descriptor (not lsof's `mem` rows). Null when the process is gone, belongs to another user, or on Windows.
 */
export function listOpenFiles(pid: number): OpenFile[] | null {
    if (processPlatform() === "linux") {
        return linuxOpenFiles(pid);
    }

    return darwinKernel() ? listOpenFileEntries(pid, readProcessCwd(pid)) : null;
}

/** Open descriptors of the process (Windows: open handles); null when unreadable. */
export function countOpenFiles(pid: number): number | null {
    switch (processPlatform()) {
        case "linux":
            return countProcFds(pid);
        case "win32":
            return listCimProcesses(pid)[0]?.handles ?? null;
        default:
            return darwinKernel() ? countOpenFds(pid) : null;
    }
}

/**
 * The inode of the file the process executes, as `lsof -d txt -Fi` reports it. The kernel resolves the executable's
 * path from its vnode, so a binary renamed or moved after the start still answers with its inode (a retired app
 * bundle). Linux stats `/proc/<pid>/exe`, which follows even a deleted binary. Null on Windows or when unreadable.
 */
export function executableInode(pid: number): number | null {
    const path = processPlatform() === "linux" ? `/proc/${pid}/exe` : darwinKernel() ? readProcessPath(pid) : null;

    if (path === null) {
        return null;
    }

    try {
        return statSync(path).ino;
    } catch {
        return null;
    }
}
