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

/// The files, the focus flag and the changes of `--markdown [paths...] [--no-focus] [--diff <scope>]`. `open --args`
/// starts the face in `/`, so a relative path names nothing; absolute paths are what callers send. `--diff` takes
/// `unstaged`, `staged`, `uncommitted`, `branch`, `last` or `commit:<sha>` (MarkdownDiffRequest).
func markdownRequest(_ args: [String]) -> (paths: [String], focus: Bool, diff: MarkdownDiffRequest?) {
    var paths: [String] = []
    var diff: MarkdownDiffRequest?
    var index = 0
    while index < args.count {
        let arg = args[index]
        if arg == "--diff", index + 1 < args.count {
            diff = MarkdownDiffRequest.parse(args[index + 1])
            index += 2
            continue
        }
        if !arg.hasPrefix("-") {
            paths.append(URL(fileURLWithPath: (arg as NSString).expandingTildeInPath).path)
        }
        index += 1
    }
    return (paths, !args.contains("--no-focus"), diff)
}

package func runMarkdown(_ args: [String]) -> Never {
    let (paths, focus, diff) = markdownRequest(args)
    HubPerf.log("markdown: launch with \(paths.count) file(s), focus=\(focus)")
    if !markdownInstance.claim() {
        exit(markdownInstance.forward(args) ? 0 : 1)
    }
    MainActor.assumeIsolated {
        markdownInstance.serve { forwarded in
            let request = markdownRequest(forwarded)
            MainActor.assumeIsolated {
                MarkdownDocumentWindowController.shared.show(paths: request.paths, focus: request.focus, diff: request.diff)
            }
        }
        _ = NSApplication.shared
        WindowCycle.install()
        MarkdownViewerApp.run(MarkdownViewerAppConfiguration(
            appName: "GenesisTools",
            paths: paths,
            focus: focus,
            diff: diff,
            // Links reach the link relay (LinkRelay.swift), never this face.
            handleURL: { url in HubPerf.log("markdown: url \(url.absoluteString) is not handled by this face") }
        ))
    }
    // `MarkdownViewerApp.run` never returns; `assumeIsolated` hides that from the compiler.
    exit(0)
}
