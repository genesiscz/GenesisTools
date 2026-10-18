import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/**
 * Why the tmux socket at `socket` is not this run's own, or undefined when it is: a real socket, not a symlink, whose
 * real path lies inside `root`. The test preload kills the server on that socket at exit, so a symlink planted at the
 * path (or a symlinked socket folder) would otherwise aim `kill-server` at a server outside the run. The socket must
 * exist; the caller checks that first.
 */
export function foreignTmuxSocketReason(root: string, socket: string): string | undefined {
    const stats = lstatSync(socket);
    if (stats.isSymbolicLink()) {
        return "is a symlink";
    }

    if (!stats.isSocket()) {
        return "is not a socket";
    }

    // realpath cannot open a socket on macOS (EOPNOTSUPP), and the lstat above proves the last component is no link,
    // so resolving the folder resolves the socket.
    const realRoot = realpathSync(root);
    const realSocket = join(realpathSync(dirname(socket)), basename(socket));
    if (!realSocket.startsWith(realRoot + sep)) {
        return `resolves to ${realSocket}, outside ${realRoot}`;
    }

    return undefined;
}
