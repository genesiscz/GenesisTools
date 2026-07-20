/**
 * Best-effort vitrinka publishing of capture products (strip / crops / frames).
 * Failures land in the returned error, never crash the run.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { CropOut, FrameInfo, VitrinkaSpec } from "./capture-plan";
import { runCmd } from "./peekaboo";

export function publishVitrinka(
    spec: VitrinkaSpec,
    sessionDir: string,
    frames: FrameInfo[],
    crops: CropOut[],
    strip: string | null
): { ok: boolean; urls: string[]; error?: string } {
    const urls: string[] = [];
    try {
        const include = spec.include ?? ["strip"];
        const root = join(sessionDir, `vitrinka-${spec.key}`);
        const shots = join(root, "shots");
        mkdirSync(shots, { recursive: true });

        const files: { path: string; title: string }[] = [];
        if (include.includes("strip") && strip) {
            const dest = join(shots, `strip-${basename(strip)}`);
            copyFileSync(strip, dest);
            const good = crops.filter((c) => c.ok);
            files.push({ path: dest, title: `strip (${good.length} tiles)` });
        }

        if (include.includes("crops")) {
            for (const c of crops.filter((c) => c.ok && c.path !== strip)) {
                const dest = join(shots, basename(c.path));
                copyFileSync(c.path, dest);
                files.push({ path: dest, title: c.label });
            }
        }

        if (include.includes("frames")) {
            for (const f of frames) {
                const dest = join(shots, f.file);
                copyFileSync(f.path, dest);
                files.push({ path: dest, title: `frame t=${f.timestampMs}ms` });
            }
        }

        if (files.length === 0) {
            return { ok: false, urls, error: "nothing to publish (no strip/crops/frames matched include)" };
        }

        const init = runCmd([
            "vitrinka",
            "remote-init",
            "--root",
            root,
            "--project",
            spec.project,
            "--branch",
            spec.branch ?? "review",
            "--key",
            spec.key,
        ]);
        if (!init.ok) {
            return { ok: false, urls, error: `remote-init: ${init.stderr || init.stdout}` };
        }

        for (const f of files) {
            const rel = f.path.slice(root.length + 1);
            const add = runCmd([
                "vitrinka",
                "add",
                "--root",
                root,
                "--file",
                rel,
                "--surface",
                "web",
                "--route",
                spec.route ?? "/",
                "--title",
                f.title,
                "--note",
                spec.note ?? "published by capture-with-actions",
            ]);
            if (!add.ok) {
                return { ok: false, urls, error: `add ${rel}: ${add.stderr || add.stdout}` };
            }
        }

        const push = runCmd(["vitrinka", "push", "--root", root, "--title", spec.title ?? spec.key]);
        for (const line of `${push.stdout}\n${push.stderr}`.split("\n")) {
            const m = line.match(/https?:\/\/\S+/);
            if (m) {
                urls.push(m[0]);
            }
        }

        if (!push.ok) {
            return { ok: false, urls, error: `push: ${push.stderr || push.stdout}` };
        }

        if (spec.board) {
            const b = runCmd(["vitrinka", "board-from-set", "--root", root, "--slug", spec.board]);
            for (const line of `${b.stdout}\n${b.stderr}`.split("\n")) {
                const m = line.match(/https?:\/\/\S+/);
                if (m) {
                    urls.push(m[0]);
                }
            }

            if (!b.ok) {
                return { ok: false, urls, error: `board-from-set: ${b.stderr || b.stdout}` };
            }
        }

        return { ok: true, urls };
    } catch (e) {
        return { ok: false, urls, error: (e as Error).message };
    }
}
