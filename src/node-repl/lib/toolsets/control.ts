import { computerApi } from "@app/control/lib/computer-use/descriptor";
import { ComputerToolset } from "@app/control/lib/computer-use/toolset";
import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";

export class ControlToolset extends ReplToolset {
    // The copied notes name the binding this toolset exposes, so an example reads `control.…`, never `computer.…`.
    readonly api = {
        ...computerApi,
        id: "control",
        global: "control",
        title: "Native control",
        summary:
            "The computer toolset's API under the name control (the same methods and docs); load computer or control, not both.",
        notes: computerApi.notes?.map((note) => note.replaceAll("computer.", "control.")),
    };
    private readonly delegate = new ComputerToolset();

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        const { computer } = await this.delegate.bootstrap(ctx);
        return { control: computer };
    }

    override dispose(): Promise<void> {
        return this.delegate.dispose();
    }
}
