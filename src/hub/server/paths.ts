import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * `~/.genesis-tools/hub/server/hub.sock` (0600), in a folder of its own (0700), so the server never changes the
 * mode of a folder other tools share. GenesisKit's ToolsServerClient uses the same path.
 */
export function hubServerSocketPath(): string {
    return toolDataDir("hub", "server", "hub.sock");
}
