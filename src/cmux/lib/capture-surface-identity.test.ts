import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCapturedCommand } from "@app/cmux/lib/capture-journal";
import { resolveCapturedSurfaceIdentity, stableSurfaceIdForPanel } from "@app/cmux/lib/capture-surface-identity";

const runtimeId = "11111111-1111-4111-8111-111111111111";
const stableId = "22222222-2222-4222-8222-222222222222";

test("a moved panel retains its persisted identity regardless of workspace placement", () => {
    const panel = { id: runtimeId, stableSurfaceId: stableId, type: "terminal" };
    const workspace = { layout: { type: "pane" as const, pane: { panelIds: [runtimeId] } }, panels: [panel] };
    expect(stableSurfaceIdForPanel(runtimeId.toUpperCase(), [{ tabManager: { workspaces: [workspace] } }])).toBe(
        stableId
    );
    expect(
        stableSurfaceIdForPanel(runtimeId, [
            { tabManager: { workspaces: [] } },
            { tabManager: { workspaces: [workspace] } },
        ])
    ).toBe(stableId);
    expect(
        stableSurfaceIdForPanel("33333333-3333-4333-8333-333333333333", [{ tabManager: { workspaces: [workspace] } }])
    ).toBeUndefined();
});

test("a shell with its old runtime ID retains its stable association after reparenting", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-id-alias-"));
    recordCapturedCommand({
        directory,
        surfaceId: runtimeId,
        stableSurfaceId: stableId,
        command: "pwd",
        cwd: "/tmp/project",
        phase: "completed",
    });
    expect(
        resolveCapturedSurfaceIdentity({
            surfaceId: runtimeId,
            journalDirectory: directory,
            session: { path: "/fixture", savedAtMs: 1, windows: [] },
        })
    ).toBe(stableId);
});
