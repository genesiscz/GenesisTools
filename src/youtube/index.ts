import { createTranscribeCommand } from "@app/youtube/commands/transcribe";
import { Command } from "commander";

const program = new Command();

program.name("youtube").description("YouTube tools — transcription, captions, and more").version("1.0.0");

program.addCommand(createTranscribeCommand());

program.parse();
