import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { queueReplayCommand } from "@app/cmux/lib/replay-input";
import * as cli from "@genesiscz/utils/cmux/lib/cli";

afterEach(() => mock.restore());

test("unsubmitted multiline and control input never reaches the terminal", async () => {
    const send = spyOn(cli, "sendSurfaceText").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    for (const command of ["echo first\necho second", "echo first\recho second", "echo first\u001b[200~"]) {
        expect(await queueReplayCommand({ surfaceRef: "surface:1", command, enter: false })).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
});

test("explicit execution preserves multiline text and ordinary pretyping stays unsubmitted", async () => {
    const send = spyOn(cli, "sendSurfaceText").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await queueReplayCommand({ surfaceRef: "surface:1", command: "echo first\necho second", enter: true });
    expect(send).toHaveBeenLastCalledWith({ surfaceRef: "surface:1", text: "echo first\necho second\n" });
    await queueReplayCommand({ surfaceRef: "surface:1", command: "echo safe", enter: false });
    expect(send).toHaveBeenLastCalledWith({ surfaceRef: "surface:1", text: "echo safe" });
});
