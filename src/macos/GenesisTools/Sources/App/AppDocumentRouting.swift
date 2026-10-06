import AppKit

@MainActor
final class AppDocumentController: NSDocumentController {
    static let routed = AppDocumentController()

    /// AppKit also considers existing command-line path values as documents once a bundle
    /// declares document types. These paths already belong to their explicit feature handlers.
    nonisolated static func isLaunchInput(_ url: URL, arguments: [String]) -> Bool {
        let pathFlags: Set<String> = ["--tools", "--directory", "--source", "--snapshot", "--repo", "--proposal"]
        for (index, flag) in arguments.enumerated() where pathFlags.contains(flag) && index + 1 < arguments.count {
            if URL(fileURLWithPath: arguments[index + 1]).standardizedFileURL == url.standardizedFileURL { return true }
        }
        return false
    }

    override func openDocument(withContentsOf url: URL, display displayDocument: Bool,
        completionHandler: @escaping (NSDocument?, Bool, Error?) -> Void) {
        if Self.isLaunchInput(url, arguments: Array(CommandLine.arguments.dropFirst())) {
            HubPerf.log("documents: ignored a path owned by a launch option")
            completionHandler(nil, false, nil)
            return
        }
        if url.pathExtension == "recast", !CommandLine.arguments.contains("--recast") {
            let opened = AppMenuTarget.shared.openRecast(file: url.path)
            completionHandler(nil, false, opened ? nil : NSError(domain: "GenesisTools", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Recast could not be opened."]))
            return
        }
        super.openDocument(withContentsOf: url, display: displayDocument, completionHandler: completionHandler)
    }
}
