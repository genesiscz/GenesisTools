import { printLn } from "@genesiscz/utils/cli/stdout";

const size = Number.parseInt(process.argv[2] ?? "300000", 10);
await printLn("X".repeat(size));
