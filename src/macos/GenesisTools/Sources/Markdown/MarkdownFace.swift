import AppKit

// GenesisTools --markdown [paths...]: GenesisKit's markdown viewer, the same screen as Genesis Markdown, as a face of
// this bundle (`open -n ~/Applications/GenesisTools.app --args --markdown /abs/note.md`; `open -g … --no-focus`
// leaves it behind the front window). One viewer per login
// session: a later launch hands its files to the running one and exits. The vault and the other hooks come from
// GenesisKitHostAdapter (Hub/GenesisKitHost.swift).

private let markdownInstance = SingleInstance(
    name: "markdown viewer",
    lockFile: NativePreview.hubFile("markdown.lock"),
    notificationPrefix: NativePreview.namespace + ".markdown",
    retryHint: "quit that one, then open the file again.",
    log: { HubPerf.log($0) }
)

/// The files and the focus flag of `--markdown [paths...] [--no-focus]`. `open --args` starts the face in `/`, so a
/// relative path names nothing; absolute paths are what callers send.
private func markdownRequest(_ args: [String]) -> (paths: [String], focus: Bool) {
    let paths = args.filter { !$0.hasPrefix("-") }.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).path }
    return (paths, !args.contains("--no-focus"))
}

func runMarkdown(_ args: [String]) -> Never {
    let (paths, focus) = markdownRequest(args)
    HubPerf.log("markdown: launch with \(paths.count) file(s), focus=\(focus)")
    if !markdownInstance.claim() {
        exit(markdownInstance.forward(args) ? 0 : 1)
    }
    MainActor.assumeIsolated {
        markdownInstance.serve { forwarded in
            let request = markdownRequest(forwarded)
            MainActor.assumeIsolated { MarkdownDocumentWindowController.shared.show(paths: request.paths, focus: request.focus) }
        }
        MarkdownViewerApp.run(MarkdownViewerAppConfiguration(
            appName: "GenesisTools",
            paths: paths,
            focus: focus,
            // Links reach the link relay (LinkRelay.swift), never this face.
            handleURL: { url in HubPerf.log("markdown: url \(url.absoluteString) is not handled by this face") }
        ))
    }
    // `MarkdownViewerApp.run` never returns; `assumeIsolated` hides that from the compiler.
    exit(0)
}
