//
//  MarkdownPageNotice.swift
//  GenesisKit
//
//  The reading page's own answers, as a NoticePill over the bottom of the page: a link that goes nowhere ("No
//  heading “Setup” in this note"), a page that could not be drawn (one sentence, Retry, the raw error behind
//  Details), a removed property (Undo). Before this, each of these ended in a log line and the pane did nothing.
//  The notice is an AppKit subview of the WKWebView, so it also shows while the page itself is dead.
//

import AppKit
import SwiftUI
import WebKit

/// What the reading page tells the reader.
struct MarkdownPageNotice: Equatable {
    /// The one button a notice may carry.
    enum Action: Equatable {
        /// Load the page again and send the text again.
        case retry
        /// Put the properties back as they were before the last removal.
        case undoProperties
        /// Hand an allowed web address to the browser.
        case open(URL)

        var label: String {
            switch self {
            case .retry: "Retry"
            case .undoProperties: "Undo"
            case .open: "Open in browser"
            }
        }

        var symbol: String {
            switch self {
            case .retry: "arrow.clockwise"
            case .undoProperties: "arrow.uturn.backward"
            case .open: "safari"
            }
        }
    }

    enum Kind: Equatable {
        /// A link, a heading or a picture that cannot be followed. Goes by itself.
        case link
        /// The page could not be drawn. Stays until Retry works or the reader closes it.
        case failure
        /// A change that can be taken back. Goes by itself.
        case undo
    }

    var text: String
    var detail: String?
    /// The raw message, shown only after a click on Details.
    var more: String?
    var kind: Kind
    var action: Action?
    /// Identifies this removal in the page; an older Undo must never target a newer removal.
    var undoToken: Int?

    var tone: NoticePill.Tone {
        switch kind {
        case .link: .warning
        case .failure: .error
        case .undo: .success
        }
    }

    /// Seconds on screen before it goes by itself; nil = until dismissed. The same six seconds as NoticePill's
    /// own fade.
    var lasts: Double? { kind == .failure ? nil : 6 }

    // MARK: The texts

    static func noHeading(_ heading: String) -> MarkdownPageNotice {
        MarkdownPageNotice(text: "No heading “\(heading)” in this note.", kind: .link)
    }

    /// A link whose scheme the page never hands to the system (`ssh:`, an app's own scheme).
    static func blockedLink(_ href: String) -> MarkdownPageNotice {
        let scheme = URL(string: href)?.scheme?.lowercased()
        let text = scheme.map { "The viewer does not open \($0): links." } ?? "The viewer cannot open this link."
        return MarkdownPageNotice(text: text, detail: "It opens web, mail and Obsidian links, and files.", kind: .link)
    }

    static let noFileLinks = MarkdownPageNotice(text: "Links to files do not open in this pane.", kind: .link)

    /// The page drew a task box that the note's text does not have where the page says. Nothing was changed.
    static let taskNotFound = MarkdownPageNotice(text: "This task was not found in the note, so nothing was changed.",
                                                 detail: "The Source mode shows the line as it is.", kind: .link)

    static func remotePicture(_ src: String) -> MarkdownPageNotice {
        MarkdownPageNotice(text: "This picture is on the web, so the viewer cannot open it.", kind: .link,
                           action: MarkdownWebView.externalURL(src).map(Action.open))
    }

    static let pictureGone = MarkdownPageNotice(text: "This picture is no longer there.",
                                                detail: "It was moved or deleted after the note was drawn.", kind: .link)

    static func failure(_ raw: String) -> MarkdownPageNotice {
        MarkdownPageNotice(text: "This page could not be drawn.", detail: "The Source mode still shows the text.",
                           more: raw, kind: .failure, action: .retry)
    }

    static func propertyRemoved(_ name: String) -> MarkdownPageNotice {
        let text = name.isEmpty ? "Property removed." : "Property “\(name)” removed."
        return MarkdownPageNotice(text: text, kind: .undo, action: .undoProperties)
    }

    static func itemRemoved(_ item: String, from name: String) -> MarkdownPageNotice {
        MarkdownPageNotice(text: "“\(item)” removed from \(name.isEmpty ? "the property" : name).", kind: .undo,
                           action: .undoProperties)
    }
}

/// The page's independent notices, on a backing that reads over the text.
struct MarkdownPageNoticeView: View {
    let model: NoticeStackModel
    let width: CGFloat
    let onFrame: (CGRect) -> Void
    private static let space = "markdown-page-notice"

    var body: some View {
        NoticeStackView(model, maxWidth: width)
            .background(GeometryReader { geo in
                Color.clear
                    .onAppear { onFrame(geo.frame(in: .named(Self.space))) }
                    .onChange(of: geo.frame(in: .named(Self.space))) { _, frame in onFrame(frame) }
            })
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .coordinateSpace(name: Self.space)
            .accessibilityIdentifier("markdown-page-notice")
    }
}

/// The notice's host. A click outside the stack falls through to the page, and a size change (Details opened)
/// places it again.
final class MarkdownPageNoticeHost: NSHostingView<MarkdownPageNoticeView> {
    var pill: CGRect = .zero
    var onResize: (() -> Void)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        let rect = isFlipped ? pill : CGRect(x: pill.minX, y: bounds.height - pill.maxY, width: pill.width, height: pill.height)
        guard rect.contains(local) else { return nil }
        return super.hitTest(point)
    }

    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        onResize?()
    }
}

extension MarkdownWebView.Coordinator {
    /// Adds a result without replacing another result's action.
    @MainActor
    func show(_ notice: MarkdownPageNotice) {
        guard let web else { return }
        pageNoticeValues = pageNoticeValues.filter { pageNotices.contains($0.key) }
        let actions: [StackedNotice.Action] = notice.action.map { action in
            [.init(action.label, symbol: action.symbol, afterPress: action == .undoProperties ? .wait("Undoing…") : .keep) { [weak self] id in
                self?.perform(notice, id: id)
            }]
        } ?? []
        let id = pageNotices.push(StackedNotice(text: notice.text, detail: notice.detail, more: notice.more,
                                              tone: notice.tone, actions: actions,
                                              lasting: notice.lasts.map { .seconds($0) } ?? .untilDismissed))
        pageNoticeValues[id] = notice
        if noticeHost?.superview !== web {
            noticeHost?.removeFromSuperview()
            let host = MarkdownPageNoticeHost(rootView: MarkdownPageNoticeView(
                model: pageNotices, width: Self.noticeWidth(in: web),
                onFrame: { [weak self] frame in self?.noticeHost?.pill = frame }))
            host.onResize = { [weak self] in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.layoutNotice() } }
            }
            web.addSubview(host)
            web.postsFrameChangedNotifications = true
            noticeFrameWatch = NotificationCenter.default.addObserver(
                forName: NSView.frameDidChangeNotification, object: web, queue: .main
            ) { [weak self] _ in MainActor.assumeIsolated { self?.layoutNotice() } }
            noticeHost = host
        }
        layoutNotice()
    }

    /// Clears failures after a successful render, preserving unrelated results.
    @MainActor
    func hideFailures() {
        for (id, notice) in pageNoticeValues where notice.kind == .failure {
            pageNotices.dismiss(id)
            pageNoticeValues[id] = nil
        }
    }

    /// Clears results when leaving the page.
    @MainActor
    func hideNotice() {
        for notice in pageNotices.notices { pageNotices.dismiss(notice.id) }
        pageNoticeValues.removeAll()
        noticeHost?.removeFromSuperview()
        noticeHost = nil
        if let noticeFrameWatch {
            NotificationCenter.default.removeObserver(noticeFrameWatch)
            self.noticeFrameWatch = nil
        }
    }

    static func noticeWidth(in web: NSView) -> CGFloat {
        max(200, min(520, web.bounds.width - 32))
    }

    /// Bottom centre of the page, 16 pt up.
    @MainActor
    func layoutNotice() {
        guard let web, let host = noticeHost, host.superview === web else { return }
        let width = Self.noticeWidth(in: web)
        if host.rootView.width != width {
            let old = host.rootView
            host.rootView = MarkdownPageNoticeView(model: pageNotices, width: width, onFrame: old.onFrame)
        }
        let height = host.fittingSize.height
        let x = (web.bounds.width - width) / 2
        let y = web.isFlipped ? web.bounds.height - height - 16 : 16
        let frame = CGRect(x: x, y: y, width: width, height: height).integral
        if host.frame != frame { host.frame = frame }
    }

    @MainActor
    private func perform(_ notice: MarkdownPageNotice, id: StackedNotice.ID) {
        switch notice.action {
        case .retry?:
            retryPage()
        case .undoProperties?:
            guard let token = notice.undoToken else {
                pageNotices.push(StackedNotice(text: "This removal no longer has an Undo action.", tone: .warning), replacing: id)
                return
            }
            web?.evaluateJavaScript("window.gnPropsUndo&&window.gnPropsUndo(\(token))") { [weak self] result, error in
                MainActor.assumeIsolated {
                    guard let self, self.pageNotices.contains(id) else { return }
                    if error == nil, result as? Bool == true {
                        self.pageNotices.push(StackedNotice(text: "Removal undone.", tone: .success), replacing: id)
                    } else {
                        self.pageNotices.release(id)
                        self.pageNotices.push(StackedNotice(text: "The properties have changed since this removal.",
                            detail: "Undo later removals first, or restore the property by hand. Current values were kept.", tone: .warning))
                    }
                }
            }
        case .open(let url)?:
            pageNotices.dismiss(id)
            if let allowed = MarkdownWebView.externalURL(url.absoluteString) { NSWorkspace.shared.open(allowed) }
        case nil:
            break
        }
    }
}
