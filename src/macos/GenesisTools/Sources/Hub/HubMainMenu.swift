import AppKit

/// The menu bar of the hub and review windows. They had none, so ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z had no
/// key equivalent: a WKWebView (the diff) or a selectable SwiftUI `Text` never got `copy:`, and
/// AppKit played the alert sound instead (2026-09-25). The first item is the app menu, as macOS
/// requires; Copy goes through `CopyWithFeedback`, which confirms a copy with the copy toast.
@MainActor
enum AppMainMenu {
    static func install() {
        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ProcessInfo.processInfo.processName
        let bar = NSMenu()

        let app = NSMenu(title: name)
        app.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(withTitle: name, action: nil, keyEquivalent: "").submenu = app

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
            .keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        let copy = edit.addItem(withTitle: "Copy", action: #selector(CopyWithFeedback.copyWithFeedback(_:)), keyEquivalent: "c")
        copy.target = CopyWithFeedback.shared
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
            .keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        bar.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

        NSApp.mainMenu = bar
    }
}

/// Edit ▸ Copy: sends `copy:` to whatever has the keyboard (a text view, a selectable `Text`, the
/// diff's web view), then shows the copy toast once the pasteboard changed. A WKWebView writes the
/// pasteboard when its web process answers, a moment later, so it looks three times, 0.1 s apart.
/// Nothing to copy sends nothing and stays silent, where the missing menu used to beep.
@MainActor
final class CopyWithFeedback: NSObject {
    static let shared = CopyWithFeedback()

    @objc func copyWithFeedback(_ sender: Any?) {
        let before = NSPasteboard.general.changeCount
        guard NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: sender) else {
            HubPerf.log("copy ⌘C: nothing has the keyboard to copy from")
            return
        }

        confirm(since: before, attempt: 0)
    }

    private func confirm(since before: Int, attempt: Int) {
        let pasteboard = NSPasteboard.general
        if pasteboard.changeCount != before {
            HubCopyToast.post(title: "Copied", detail: HubCopyToast.preview(pasteboard.string(forType: .string) ?? ""), style: .copied)
            return
        }

        guard attempt < 3 else {
            HubPerf.log("copy ⌘C: the pasteboard did not change (nothing selected)")
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            MainActor.assumeIsolated { self?.confirm(since: before, attempt: attempt + 1) }
        }
    }
}
