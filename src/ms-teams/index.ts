#!/usr/bin/env bun

import { registerCallsCommand } from "@app/ms-teams/commands/calls";
import { registerConversationsCommand } from "@app/ms-teams/commands/conversations";
import { registerDoctorCommand } from "@app/ms-teams/commands/doctor";
import { registerFilesCommand } from "@app/ms-teams/commands/files";
import { registerMcpCommand } from "@app/ms-teams/commands/mcp";
import { registerMeetingsCommand } from "@app/ms-teams/commands/meetings";
import { registerMembersCommand } from "@app/ms-teams/commands/members";
import { registerMentionsCommand } from "@app/ms-teams/commands/mentions";
import { registerPeopleCommand } from "@app/ms-teams/commands/people";
import { registerSearchCommand } from "@app/ms-teams/commands/search";
import { registerShowCommand } from "@app/ms-teams/commands/show";
import { registerSyncCommand } from "@app/ms-teams/commands/sync";
import { registerTranscriptsCommand } from "@app/ms-teams/commands/transcripts";
import { enhanceHelp, isInteractive, runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
    .name("ms-teams")
    .description("Read Microsoft Teams chats from the local desktop cache")
    .version("1.0.0")
    .showHelpAfterError(true);

registerSyncCommand(program);
registerDoctorCommand(program);
registerConversationsCommand(program);
registerShowCommand(program);
registerSearchCommand(program);
registerPeopleCommand(program);
registerMembersCommand(program);
registerFilesCommand(program);
registerCallsCommand(program);
registerMeetingsCommand(program);
registerMentionsCommand(program);
registerTranscriptsCommand(program);
registerMcpCommand(program);

program.action(() => {
    if (!isInteractive()) {
        program.help();
        return;
    }

    program.help();
});

enhanceHelp(program);

await runTool(program, { tool: "ms-teams" }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    process.exit(1);
});
