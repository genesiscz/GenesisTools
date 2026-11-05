/**
 * The host's copy of the face declarations. The Swift host cannot import parts.ts, so the declarations reach it as a
 * generated Swift file: `AppFaces.declared` in `Sources/Host/AppFaces+Declared.swift`. A build writes it when it
 * differs (app.ts), `bun scripts/native/app-faces.ts --write` writes it by hand, and permissions.test.ts fails when the
 * committed file and the declarations drift apart.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_FACES, type DeclaredFace } from "./parts";

export const SWIFT_FACE_TABLE_PATH = resolve(
    import.meta.dirname,
    "../../GenesisTools/Sources/Host/AppFaces+Declared.swift"
);

export const SWIFT_FACE_TABLE_WRITE_COMMAND = "bun scripts/native/app-faces.ts --write";

function swiftString(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function swiftFace(face: DeclaredFace): string {
    const aliases = `[${(face.aliases ?? []).map(swiftString).join(", ")}]`;
    const part = face.part === undefined ? "nil" : swiftString(face.part);
    const quit = face.quit ? `.init(name: ${swiftString(face.quit.name)}, order: ${face.quit.order})` : "nil";
    return `        AppFace(flag: ${swiftString(face.flag)}, aliases: ${aliases}, part: ${part}, window: ${face.window}, quit: ${quit}),`;
}

/** The Swift file for `faces`, byte for byte. */
export function renderSwiftFaceTable(faces: readonly DeclaredFace[] = APP_FACES): string {
    return [
        "// Generated from the face declarations in src/macos/lib/permissions/parts.ts by",
        `// \`${SWIFT_FACE_TABLE_WRITE_COMMAND}\` (a build writes it too). Do not edit it: change parts.ts.`,
        "// src/macos/lib/permissions/permissions.test.ts fails when this file and the declarations drift apart.",
        "",
        "extension AppFaces {",
        "    /// Every face: each part's faces in the order of APP_PARTS, then the host's own window.",
        "    static let declared: [AppFace] = [",
        ...faces.map(swiftFace),
        "    ]",
        "}",
        "",
    ].join("\n");
}

/** True when the Swift file holds exactly the current declarations. */
export function swiftFaceTableIsCurrent(path = SWIFT_FACE_TABLE_PATH): boolean {
    return existsSync(path) && readFileSync(path, "utf8") === renderSwiftFaceTable();
}

/** Writes the Swift file when it differs from the declarations; true when it wrote. */
export function syncSwiftFaceTable(path = SWIFT_FACE_TABLE_PATH): boolean {
    if (swiftFaceTableIsCurrent(path)) {
        return false;
    }

    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, renderSwiftFaceTable());
    renameSync(temporary, path);
    return true;
}
