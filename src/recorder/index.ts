import { createRecorderProgram, RECORDER_REGISTRARS } from "@app/recorder/registrars";
import { runTool } from "@genesiscz/utils/cli";

await runTool(createRecorderProgram(), { tool: "recorder", registrars: RECORDER_REGISTRARS });
