/**
 * Debug version: hex-dump the raw entry buffer to figure out the real layout.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const dir = process.argv[2];
if (!dir) {
    console.error("usage: <dir>");
    process.exit(2);
}

const lib = dlopen("libSystem.dylib", {
    getattrlistbulk: {
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
    },
    open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
});

const ATTR_BIT_MAP_COUNT = 5;
const ATTR_CMN_NAME = 0x00000001;
const ATTR_CMN_OBJTYPE = 0x00000008;
const ATTR_CMN_MODTIME = 0x00000400;
const ATTR_CMN_FILEID = 0x02000000;
const ATTR_CMN_ERROR = 0x20000000;
const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_FILE_TOTALSIZE = 0x00000002;
const ATTR_CMNEXT_CLONEID = 0x00000100;
const FSOPT_PACK_INVAL_ATTRS = 0x00000008;
const FSOPT_ATTR_CMN_EXTENDED = 0x00000020;

const attrlist = new ArrayBuffer(24);
const al = new DataView(attrlist);
al.setUint16(0, ATTR_BIT_MAP_COUNT, true);
al.setUint16(2, 0, true);
al.setUint32(
    4,
    ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE | ATTR_CMN_MODTIME | ATTR_CMN_FILEID | ATTR_CMN_ERROR,
    true
);
al.setUint32(8, 0, true);
al.setUint32(12, 0, true);
al.setUint32(16, ATTR_FILE_TOTALSIZE, true);
al.setUint32(20, ATTR_CMNEXT_CLONEID, true);

const cPath = Buffer.from(`${dir}\0`);
const fd = lib.symbols.open(cPath, 0 | 0x100000);
if (fd < 0) {
    console.error(`open(${dir}) failed`);
    process.exit(1);
}

const BUF_BYTES = 32 * 1024;
const buf = new ArrayBuffer(BUF_BYTES);
const bufPtr = ptr(buf);
const view = new DataView(buf);
const u8 = new Uint8Array(buf);
const opts = BigInt(FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS);

function hex(bytes: Uint8Array, len: number): string {
    const parts: string[] = [];
    for (let i = 0; i < len; i += 16) {
        const chunk = bytes.slice(i, Math.min(i + 16, len));
        const hexStr = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        parts.push(`  ${i.toString(16).padStart(4, "0")}: ${hexStr.padEnd(48, " ")}  |${ascii}|`);
    }
    return parts.join("\n");
}

const n = lib.symbols.getattrlistbulk(fd, ptr(attrlist), bufPtr, BigInt(BUF_BYTES), opts);
console.error(`getattrlistbulk returned ${n} entries`);
if (n > 0) {
    let off = 0;
    for (let i = 0; i < Math.min(n, 2); i++) {
        const entryLen = view.getUint32(off, true);
        console.log(`--- entry ${i}: len=${entryLen} starts at buf+${off} ---`);
        console.log(hex(u8.subarray(off, off + entryLen), entryLen));
        off += entryLen;
    }
}

lib.symbols.close(fd);
