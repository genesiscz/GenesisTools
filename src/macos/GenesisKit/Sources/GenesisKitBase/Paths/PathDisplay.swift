import Foundation

/// How a path is shown in a label or a toast: the home folder as `~`.
public enum PathDisplay {
    public static func tilde(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path == home {
            return "~"
        }

        // Only below the home folder: a sibling such as `/Users/mean` keeps its full path.
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }
}
