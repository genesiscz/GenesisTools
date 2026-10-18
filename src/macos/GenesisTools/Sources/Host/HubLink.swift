import Foundation

/// `genesis-tools://hub?…` links. In the host, not the hub part: the link router and main.swift must recognise a hub
/// link in a build without the hub, so it is not routed to the browser.
package enum HubLink {
    /// The flags a link may carry. Never `--snapshot`, `--bench`, `--set` or `--menu`: a link is a place to
    /// show, not a file to write or a command to run.
    package static let linkKeys: Set<String> = [
        "mode", "session", "agent", "pr", "reveal", "commit", "repo", "tab", "filter", "worktree", "decision", "question",
    ]

    /// `genesis-tools://hub?session=<parent>&agent=<child>` (any of `linkKeys`) as `--hub` arguments, the
    /// same ones `tools hub open` passes; nil for any other URL.
    package static func arguments(fromLink raw: String) -> [String]? {
        guard let components = URLComponents(string: raw), components.scheme == "genesis-tools", components.host == "hub" else { return nil }
        var args: [String] = []
        for item in components.queryItems ?? [] where linkKeys.contains(item.name) {
            guard let value = item.value, !value.isEmpty else { continue }
            args += ["--\(item.name)", value]
        }
        return args
    }
}
