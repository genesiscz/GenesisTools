import SwiftUI

/// One way to fix what a notice reports. A button says in its label what it does; a button that changes something
/// outside the view (quits an app, stops a process) asks first, inside the notice, so the question also works in a
/// panel that never becomes key. A command is for the person's terminal: the notice shows it and copies it.
public struct NoticeFix: Identifiable {
    /// The question a button asks before it acts, and what its confirming button says.
    public struct Confirmation {
        public let question: String
        public let consequence: String?
        public let confirmLabel: String

        public init(_ question: String, consequence: String? = nil, confirmLabel: String) {
            self.question = question
            self.consequence = consequence
            self.confirmLabel = confirmLabel
        }
    }

    public enum Kind {
        case action(confirm: Confirmation?, perform: @MainActor () -> Void)
        case command(String)
    }

    public let label: String
    public let symbol: String?
    public let kind: Kind
    public var id: String {
        switch kind {
        case .action: return "action:" + label
        case .command(let command): return "command:" + command
        }
    }

    /// `label` says what a press does ("Quit the older Genesis (pid 1234)"); `confirm` makes it ask first.
    public static func button(_ label: String, symbol: String? = nil, confirm: Confirmation? = nil,
                              perform: @escaping @MainActor () -> Void) -> NoticeFix {
        NoticeFix(label: label, symbol: symbol, kind: .action(confirm: confirm, perform: perform))
    }

    /// `label` says what the command does ("Or quit it from a terminal").
    public static func command(_ label: String, _ command: String) -> NoticeFix {
        NoticeFix(label: label, symbol: nil, kind: .command(command))
    }
}

/// A status line: icon, message, optional dim detail, the fixes, and the full message behind "Details". A success
/// notice without fixes fades after six seconds; an error, a warning or a notice with a fix stays until it is
/// dismissed or no longer applies.
public struct NoticePill: View {
    public enum Tone: Sendable {
        case success, warning, error

        var color: Color {
            switch self {
            case .success: return KitPalette.added
            case .warning: return KitPalette.modified
            case .error: return KitPalette.removed
            }
        }

        var symbol: String { self == .success ? "checkmark.circle.fill" : "exclamationmark.triangle.fill" }
    }

    let text: String
    var detail: String?
    /// The full message behind a short `text` (a CLI's raw error, what was found), shown only after a click on "Details".
    var more: String?
    var tone: Tone
    var fixes: [NoticeFix]
    /// Nil: no close icon, for a notice that stays while what it reports is true.
    let dismiss: (() -> Void)?
    @State private var showsMore = false
    @State private var confirming: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(text: String, detail: String? = nil, more: String? = nil, isError: Bool = false,
                fixes: [NoticeFix] = [], dismiss: (() -> Void)? = nil) {
        self.init(text: text, detail: detail, more: more, tone: isError ? .error : .success, fixes: fixes, dismiss: dismiss)
    }

    public init(text: String, detail: String? = nil, more: String? = nil, tone: Tone,
                fixes: [NoticeFix] = [], dismiss: (() -> Void)? = nil) {
        self.text = text
        self.detail = detail
        self.more = more
        self.tone = tone
        self.fixes = fixes
        self.dismiss = dismiss
    }

    // The message wraps instead of ending in "…": an error cut to one line could not be read
    // ("Reservine/ReservineBack#815 is not a…", 2026-10-04). One line keeps the capsule; more lines
    // get a rounded box of the same look, and the text can be selected and copied.
    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: tone.symbol).foregroundColor(tone.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(text).font(.system(size: 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail).font(.system(size: 11.5)).foregroundColor(KitPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !fixes.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(fixes) { fix in fixRow(fix) }
                    }
                    .padding(.top, 5)
                    .padding(.bottom, 2)
                }
                if let more {
                    Button {
                        GenMotion.perform(expanding: !showsMore, reduceMotion: reduceMotion) { showsMore.toggle() }
                    } label: {
                        Label(showsMore ? "Hide details" : "Details",
                              systemImage: showsMore ? "chevron.down" : "chevron.right")
                            .font(.system(size: 11))
                            .foregroundColor(KitPalette.dim)
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(showsMore ? "Hide the full message" : "Show the full message")
                    .accessibilityValue(showsMore ? "Expanded" : "Collapsed")
                    if showsMore {
                        Text(more).font(.system(size: 11, design: .monospaced)).foregroundColor(KitPalette.dim)
                            .fixedSize(horizontal: false, vertical: true)
                            .transition(.genReveal)
                    }
                }
            }
            .textSelection(.enabled)
            .multilineTextAlignment(.leading)
            if let dismiss {
                IconButton(systemName: "xmark", tooltip: "Dismiss", size: 9, action: dismiss)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, dismiss == nil ? 10 : 4)
        .padding(.vertical, fixes.isEmpty ? 3 : 7)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).stroke(Color.white.opacity(0.1)))
        .task(id: text) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if tone == .success, fixes.isEmpty { dismiss?() }
        }
    }

    @ViewBuilder
    private func fixRow(_ fix: NoticeFix) -> some View {
        switch fix.kind {
        case .action(let confirm, let perform):
            VStack(alignment: .leading, spacing: 5) {
                Button {
                    if confirm == nil { perform() } else { toggleConfirmation(fix.id) }
                } label: {
                    fixLabel(fix.label, symbol: fix.symbol ?? "wrench.and.screwdriver", tint: tone == .success ? KitPalette.renamed : tone.color)
                }
                .buttonStyle(.genHoverPlain())
                .disabled(confirming == fix.id)
                .accessibilityIdentifier("notice-fix-" + fix.label)
                if let confirm, confirming == fix.id {
                    confirmation(confirm, perform: perform)
                        .transition(.genReveal)
                }
            }
        case .command(let command):
            VStack(alignment: .leading, spacing: 3) {
                Text(fix.label).font(.system(size: 11)).foregroundColor(KitPalette.dim)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(verbatim: command).font(.system(size: 11, design: .monospaced))
                        .foregroundColor(Color.white.opacity(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.black.opacity(0.25)))
                    IconButton(systemName: "doc.on.doc", tooltip: "Copy the command", size: 10) {
                        Clipboard.copy(command, what: "command")
                    }
                }
            }
            .accessibilityIdentifier("notice-command-" + fix.label)
        }
    }

    private func confirmation(_ confirm: NoticeFix.Confirmation, perform: @escaping @MainActor () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(confirm.question).font(.system(size: 11.5, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            if let consequence = confirm.consequence {
                Text(consequence).font(.system(size: 11)).foregroundColor(KitPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Button {
                    toggleConfirmation(nil)
                    perform()
                } label: {
                    fixLabel(confirm.confirmLabel, symbol: "checkmark", tint: KitPalette.removed)
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityIdentifier("notice-confirm-" + confirm.confirmLabel)
                Button("Cancel") { toggleConfirmation(nil) }
                    .font(.system(size: 11))
                    .foregroundColor(KitPalette.dim)
                    .buttonStyle(.genHoverPlain())
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.white.opacity(0.05)))
    }

    private func fixLabel(_ text: String, symbol: String, tint: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.14)))
            .contentShape(Capsule())
    }

    private func toggleConfirmation(_ id: String?) {
        GenMotion.perform(expanding: id != nil, reduceMotion: reduceMotion) { confirming = id }
    }
}
