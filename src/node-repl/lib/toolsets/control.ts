import { computerApi } from "@app/control/lib/computer-use/descriptor";
import { ComputerToolset } from "@app/control/lib/computer-use/toolset";
import { ReplToolset, type ToolsetContext } from "@genesiscz/utils/repl/toolset";

export class ControlToolset extends ReplToolset {
    readonly api = {
        ...computerApi,
        id: "control",
        global: "control",
        title: "Native control",
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
