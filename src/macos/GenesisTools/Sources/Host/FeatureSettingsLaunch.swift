import AppKit

/// The same destination travels in the child process's argv and in a reopen notification to an existing window.
package struct FeatureSettingsRequest: Equatable {
    package let pageID: String?
    package let context: String?

    package init(pageID: String?, context: String? = nil) {
        self.pageID = pageID
        self.context = context
    }

    package init(arguments: [String]) {
        func value(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1),
                  !arguments[index + 1].hasPrefix("--") else { return nil }
            return arguments[index + 1]
        }
        self.init(pageID: value("--page"), context: value("--page-context"))
    }

    package var arguments: [String] {
        (pageID.map { ["--page", $0] } ?? []) + (context.map { ["--page-context", $0] } ?? [])
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
