import AppKit

/// The same destination travels in the child process's argv and in a reopen notification to an existing window.
package struct FeatureSettingsRequest: Equatable {
    package let pageID: String?
    package let context: String?

    package init(pageID: String?, context: String? = nil) {
        self.pageID = pageID
        self.context = context
    }

    /// Reads `--page=<id>` and `--page-context=<text>`, the form `arguments` writes: the value is everything after the
    /// first `=`, so a value that starts with `--` or holds `=` comes back as it went in. The spaced form a person types
    /// (`--page general`) still reads, when its value is not the next flag.
    package init(arguments: [String]) {
        func value(_ flag: String) -> String? {
            if let joined = arguments.first(where: { $0.hasPrefix(flag + "=") }) {
                return String(joined.dropFirst(flag.count + 1))
            }
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1),
                  !arguments[index + 1].hasPrefix("--") else { return nil }
            return arguments[index + 1]
        }
        self.init(pageID: value("--page"), context: value("--page-context"))
    }

    /// One argument per value (`--page=<id>`), never a flag and a separate value: a value that looks like a flag
    /// would otherwise be dropped by the reader, and Settings would open elsewhere than a reopen notification sends it.
    package var arguments: [String] {
        (pageID.map { ["--page=\($0)"] } ?? []) + (context.map { ["--page-context=\($0)"] } ?? [])
    }

    package init(userInfo: [AnyHashable: Any]?) {
        self.init(pageID: userInfo?["page"] as? String, context: userInfo?["context"] as? String)
    }

    package var userInfo: [String: String] {
        ["page": pageID, "context": context].compactMapValues { $0 }
    }
}

/// Opens the feature settings window in its own `GenesisTools --features` process (Parts/Features). In the host, not a
/// part: the hub and the widget open it, and a build without the features part answers with the command that adds it
/// (AppParts.swift).
@MainActor
package enum FeatureSettingsLaunch {
    static let face = "--features"

    package static func open(pageID: String? = nil, context: String? = nil) {
        guard AppParts.canLaunch(face: face) else { return }
        FaceLaunch.start([face] + FeatureSettingsRequest(pageID: pageID, context: context).arguments) { error in
            let alert = NSAlert()
            alert.messageText = "Could not open Settings"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
