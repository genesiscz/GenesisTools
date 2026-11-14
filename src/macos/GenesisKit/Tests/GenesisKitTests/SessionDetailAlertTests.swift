import AppKit
import SwiftUI
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// The stuck or loop warning (`SessionDetailInfo.alert`) shows under every form of the transcript's header: the classic
/// one and both sketches of `--sketch transcript=a|b`, which dropped it.
@MainActor
final class SessionDetailAlertTests: XCTestCase {
    private func height(_ view: some View) -> CGFloat {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view.frame(width: 720).environment(\.colorScheme, .dark))
        return host.fittingSize.height
    }

    private func info(alert: String?) -> SessionDetailInfo {
        SessionDetailInfo(sessionId: "s1", title: "Fix the parser", provider: AIProviders.meta(for: "claude"),
                          cwd: "/Users/alice/shop", branch: "main", alert: alert, alertIsSevere: true)
    }

    func testEveryHeaderFormShowsTheAlertLine() {
        let actions = SessionDetailActions(alertAction: {})
        let forms: [(String, (SessionDetailInfo) -> AnyView)] = [
            ("classic", { AnyView(SessionDetailHeader(info: $0, actions: actions, leadingInset: 16, showSidebar: .constant(true))) }),
            ("sketch a", { AnyView(TranscriptSketchAPaneBar(info: $0, actions: actions, leadingInset: 16, showSidebar: .constant(true))) }),
            ("sketch b", { AnyView(TranscriptSketchBTitle(info: $0, actions: actions, leadingInset: 16, showSidebar: .constant(true))) }),
        ]
        for (name, form) in forms {
            let without = height(form(info(alert: nil)))
            let with = height(form(info(alert: "Bash has run for 14 min with no output")))
            XCTAssertEqual(with - without, 24, accuracy: 0.5, "\(name): the alert line adds its 24 pt row")
        }
    }
}
