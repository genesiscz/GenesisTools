import Foundation

/// `genesis-tools://hub?…` links. In the host, not the hub part: the link router and main.swift must recognise a hub
/// link in a build without the hub, so it is not routed to the browser.
package enum HubLink {
    /// The flags a link may carry. Never `--snapshot`, `--bench`, `--set` or `--menu`: a link is a place to
    /// show, not a file to write or a command to run.
    package static let linkKeys: Set<String> = [
        "mode", "session", "agent", "pr", "reveal", "commit", "repo", "tab", "filter", "worktree", "decision", "question",
        // The Usage mode's place: `usage-account` repeats, `usage-all-accounts` is a flag (`flagKeys`).
        "usage-section", "usage-session", "usage-harness", "usage-account", "usage-all-accounts",
        // Who asked and why, for the hub's history (`tools hub nav open`): never a command, only words on an entry.
        "actor", "note", "from", "nav",
    ]

    /// Keys that are a flag with no value in the `--hub` arguments: `1` or `true` turns one on, any other value drops it.
    package static let flagKeys: Set<String> = ["usage-all-accounts"]

    /// `genesis-tools://hub?session=<parent>&agent=<child>` (any of `linkKeys`) as `--hub` arguments, the
    /// same ones `tools hub open` passes; nil for any other URL.
    package static func arguments(fromLink raw: String) -> [String]? {
        guard let components = URLComponents(string: raw), components.scheme == "genesis-tools", components.host == "hub" else { return nil }
        var args: [String] = []
        for item in components.queryItems ?? [] {
            // `&amp;` copied out of escaped text (a subagent's task notification is XML) names the key `amp;commit`.
            let name = item.name.hasPrefix("amp;") ? String(item.name.dropFirst(4)) : item.name
            guard linkKeys.contains(name), let value = item.value, !value.isEmpty else { continue }
            if flagKeys.contains(name) {
                if value == "1" || value == "true" { args.append("--\(name)") }
                continue
            }
            args += ["--\(name)", value]
        }
        return args
    }
}
