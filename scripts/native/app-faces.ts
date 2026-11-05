#!/usr/bin/env bun
/**
 * The host's face table (src/macos/GenesisTools/Sources/Host/AppFaces+Declared.swift), generated from the face
 * declarations in src/macos/lib/permissions/parts.ts.
 *
 *   bun scripts/native/app-faces.ts --write   rewrite it when it differs from the declarations
 *   bun scripts/native/app-faces.ts --check   exit 1 when it differs
 */
import {
    SWIFT_FACE_TABLE_PATH,
    SWIFT_FACE_TABLE_WRITE_COMMAND,
    swiftFaceTableIsCurrent,
    syncSwiftFaceTable,
} from "@app/macos/lib/permissions/face-table";

const mode = process.argv[2];

if (mode === "--write") {
    console.log(syncSwiftFaceTable() ? `wrote ${SWIFT_FACE_TABLE_PATH}` : `current: ${SWIFT_FACE_TABLE_PATH}`);
} else if (mode === "--check") {
    if (!swiftFaceTableIsCurrent()) {
        console.error(
            `${SWIFT_FACE_TABLE_PATH} differs from the face declarations. Run: ${SWIFT_FACE_TABLE_WRITE_COMMAND}`
        );
        process.exit(1);
    }

    console.log(`current: ${SWIFT_FACE_TABLE_PATH}`);
} else {
    console.error("usage: bun scripts/native/app-faces.ts --write | --check");
    process.exit(64);
}
