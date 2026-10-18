import AppKit
import SwiftUI

// MARK: - A native menu of path actions

/// An NSMenu item that runs a closure: the diff header's right-click menu is built in Swift from
/// the file it names, for a page that only says which file was clicked.
public final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    public init(_ title: String, _ handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    @objc private func run() {
        handler()
    }
}
