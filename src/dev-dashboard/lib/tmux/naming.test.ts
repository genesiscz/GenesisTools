import { describe, expect, test } from "bun:test";
import { makeCmuxTmuxSessionName, makeTtydTmuxSessionName } from "@app/dev-dashboard/lib/tmux/naming";

describe("tmux session naming", () => {
    test("ttyd defaults to dd-<8hex>", () => {
        expect(makeTtydTmuxSessionName("58bcf039-aaaa-bbbb-cccc-dddddddddddd")).toBe("dd-58bcf039");
    });

    test("cmux defaults to dd-cmux-<8hex>", () => {
        expect(makeCmuxTmuxSessionName()).toMatch(/^dd-cmux-[0-9a-f]{8}$/);
    });
});
