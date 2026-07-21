// Bun Worker: owns a set of directories and scans them via the shared bun:ffi
// core (ffi-scan.ts). A real OS thread => the getattrlistbulk walk + openat/fcntl
// of shared files run in true parallel with the other workers, which is what makes
// the Bun engine competitive on syscall-bound clonefile trees.

import { type ScanDirsInput, scanDirs } from "./ffi-scan";

declare const self: Worker;

self.onmessage = (ev: MessageEvent<ScanDirsInput>) => {
    const r = scanDirs(ev.data);
    self.postMessage(r, [
        r.devs.buffer,
        r.lens.buffer,
        r.grps.buffer,
        r.gNaive.buffer,
        r.gFiles.buffer,
        r.gPrivate.buffer,
    ]);
};
