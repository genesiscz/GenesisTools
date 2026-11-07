import { describe, expect, test } from "bun:test";
import { transitionJoins } from "./fx";
import { applyOp, describeProject, type EditProject, editOpSchema, editProjectSchema, wholeProject } from "./project";

const source = { video: "/movies/demo.mp4", durationUs: 20_000_000, width: 1920, height: 1080 };

/** Three clips: a cut at 5 s (source jumps 5 to 8) and a split at 12 s (no join). */
function cutProject(): EditProject {
    return editProjectSchema.parse({
        ...wholeProject(source),
        clips: [
            { id: "c1", fromUs: 0, toUs: 5_000_000 },
            { id: "c2", fromUs: 8_000_000, toUs: 12_000_000 },
            { id: "c3", fromUs: 12_000_000, toUs: 20_000_000, speed: 2 },
        ],
    });
}

describe("transitions", () => {
    test("an edit without them has a hard cut at every join, and a split joins nothing", () => {
        expect(transitionJoins(cutProject())).toEqual([
            { clip: "c2", atUs: 5_000_000, kind: "none", ms: 300, own: false },
        ]);
        expect(editProjectSchema.parse(wholeProject(source)).transitions).toBeUndefined();
    });

    test("the default applies to every join; one join keeps its own until it is given the default back", () => {
        let project = applyOp(cutProject(), { op: "transition", kind: "crossfade" });
        expect(project.transitions?.default).toEqual({ kind: "crossfade", ms: 300 });
        project = applyOp(project, { op: "transition", clip: "c2", kind: "blur", ms: 600 });
        expect(describeProject(project, "/p/edit.json").transitions.joins).toEqual([
            { clip: "c2", at: 5, kind: "blur", ms: 600, own: true },
        ]);
        project = applyOp(project, { op: "transition", clip: "c2", kind: "default" });
        expect(project.transitions).toEqual({ default: { kind: "crossfade", ms: 300 } });
    });

    test("a clip that starts no join and a default without a kind are refused with what to give", () => {
        expect(() => applyOp(cutProject(), { op: "transition", clip: "c3", kind: "zoom" })).toThrow(
            /joins start at clips: c2/
        );
        expect(() => applyOp(cutProject(), { op: "transition", kind: "default" })).toThrow(/give clip/);
        expect(() => editOpSchema.parse({ op: "transition", kind: "wipe" })).toThrow();
    });
});

describe("lens", () => {
    test("a lens follows the cursor unless placed, and setLens and unlens find it by id", () => {
        const facts = { generatedIds: [] as string[] };
        let project = applyOp(cutProject(), { op: "lens", from: 1, to: 3, magnification: 3 }, facts);
        const id = facts.generatedIds[0];
        expect(project.lens?.items).toEqual([
            {
                id,
                startUs: 1_000_000,
                endUs: 3_000_000,
                radius: 0.12,
                magnification: 3,
                follow: true,
                x: 0.5,
                y: 0.5,
                ring: "#FFFFFF",
            },
        ]);
        project = applyOp(project, { op: "setLens", id, at: { x: 0.2, y: 0.8 }, radius: 0.2, ring: "#ff0000" });
        expect(project.lens?.items[0]).toMatchObject({ follow: false, x: 0.2, y: 0.8, radius: 0.2, ring: "#FF0000" });
        expect(describeProject(project, "/p/edit.json").lenses[0]).toMatchObject({ id, from: 1, to: 3, follow: false });
        expect(applyOp(project, { op: "unlens", id }).lens).toBeUndefined();
        expect(() => applyOp(project, { op: "unlens", id: "l404" })).toThrow(`no lens l404; lenses: ${id}`);
    });

    test("a lens past the end or shorter than 0.1 s is refused", () => {
        expect(() => applyOp(cutProject(), { op: "lens", from: 25, to: 26 })).toThrow(/past the end/);
        expect(() => applyOp(cutProject(), { op: "lens", from: 2, to: 2.05 })).toThrow(/at least 0.1 s/);
        expect(() => editOpSchema.parse({ op: "lens", from: 1, to: 2, magnification: 6 })).toThrow();
    });
});

describe("tilt", () => {
    test("tilt takes the defaults, merges a change, and enabled: false takes it away", () => {
        let project = applyOp(cutProject(), { op: "tilt" });
        expect(project.tilt).toEqual({
            strength: 0.5,
            drift: true,
            tiltIn: true,
            tiltOut: true,
            inMs: 1200,
            outMs: 1200,
        });
        project = applyOp(project, { op: "tilt", strength: 0.8, tiltOut: false });
        expect(project.tilt).toMatchObject({ strength: 0.8, tiltOut: false, tiltIn: true });
        expect(describeProject(project, "/p/edit.json").tilt).toMatchObject({ strength: 0.8 });
        expect(applyOp(project, { op: "tilt", enabled: false }).tilt).toBeUndefined();
    });
});
