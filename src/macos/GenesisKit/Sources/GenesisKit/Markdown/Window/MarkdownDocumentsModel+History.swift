import Foundation

/// Back and Forward through the notes shown (Martin, 2026-10-15: ⌘ with the two keys right of P, "ú" and ")" on his
/// Czech keyboard). A note whose tab was closed opens again; a file that is gone is stepped over.
extension MarkdownDocumentsModel {
    func goBack() {
        navigate { $0.back(where: isReachable) }
    }

    func goForward() {
        navigate { $0.forward(where: isReachable) }
    }

    var canGoBack: Bool { history.canGoBack(where: isReachable) }
    var canGoForward: Bool { history.canGoForward(where: isReachable) }

    /// A closed file that is not open again. Reopen Closed Tab is dimmed without one.
    var canReopenClosedTab: Bool {
        recentlyClosed.contains { url in !docs.contains { $0.url == url } }
    }

    private func navigate(_ step: (inout MarkdownNavigationHistory) -> String?) {
        guard let id = step(&history) else { return }
        navigatingHistory = true
        defer { navigatingHistory = false }
        if docs.contains(where: { $0.id == id }) {
            select(id)
        } else {
            open([URL(fileURLWithPath: id)])
        }
    }

    /// An open tab, or a file still on disk.
    private func isReachable(_ id: String) -> Bool {
        docs.contains { $0.id == id } || FileManager.default.fileExists(atPath: id)
    }
}
