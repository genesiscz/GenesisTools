import AppKit
import SwiftUI

/// One line of an approval request: a short label and its value. `help` holds the full text when the value is cut.
public struct ApprovalFact: Identifiable, Equatable {
    public let label: String
    public let value: String
    public let help: String?
    public let monospaced: Bool
    /// A value shown dimmed ("No reason given").
    public let dimmed: Bool

    public var id: String { label }

    public init(_ label: String, _ value: String, help: String? = nil, monospaced: Bool = false, dimmed: Bool = false) {
        self.label = label
        self.value = value
        self.help = help
        self.monospaced = monospaced
        self.dimmed = dimmed
    }
}

/// How long an allow is remembered; `seconds` 0 is "just this once", nil is "always" (until revoked).
public struct ApprovalRemember: Identifiable, Hashable {
    public let seconds: Int?
    public let title: String

    public var id: String { title }

    public init(seconds: Int?, title: String) {
        self.seconds = seconds
        self.title = title
    }
}

/// One way out of a request the person picks before confirming (the rm window: "Move to the trash" or "Delete
/// permanently"). `id` goes back to the caller as it is.
public struct ApprovalChoice: Identifiable, Hashable {
    public let id: String
    public let title: String
    public let detail: String?

    public init(id: String, title: String, detail: String? = nil) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

/// A small link under the purpose ("Open its inbox", "Its terminal"): where the person can look before deciding.
public struct ApprovalLink: Identifiable {
    public let title: String
    public let symbol: String
    public let action: () -> Void

    public var id: String { title }

    public init(title: String, symbol: String, action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.action = action
    }
}

/// What the footer says once the request is answered and the caller is doing the work ("Approved: moving to the
/// trash"), with a command the person may copy (`tools rm restore utqzn9`).
public struct ApprovalFinish {
    public let headline: String
    public let detail: String
    public let copy: String?

    public init(headline: String, detail: String, copy: String? = nil) {
        self.headline = headline
        self.detail = detail
        self.copy = copy
    }
}

/// A request only the user may allow (a secret handed to another program): why first, then who, then the details
/// behind a disclosure. The answer arrives once, through `onAllow` or `onDeny`.
@MainActor
public final class ApprovalDialogModel: ObservableObject {
    public let title: String
    public let purpose: String
    /// The command line the request runs, shown as a code block under the purpose.
    public let command: String?
    public let symbol: String
    public let facts: [ApprovalFact]
    public let details: [ApprovalFact]
    public let warning: String?
    public let footnote: String
    public let rememberChoices: [ApprovalRemember]
    public let rememberNote: String?
    public let allowTitle: String
    public let deadline: Date?
    public let identifier: String
    /// The paths a destructive request names, as rows with their icons and open buttons (the rm window). Empty for a
    /// request that has only facts.
    public let items: [ApprovalItem]
    /// Touch ID inside the window: the sensor listens from the first frame and a touch approves (`onVerified`).
    /// nil keeps the Allow button, whose `onAllow` runs the host's own authentication.
    public let verifier: ApprovalVerifier?
    /// Links under the purpose (the asking session's inbox and terminal).
    public let links: [ApprovalLink]
    /// One line under the rows ("5 items, 34 kB, 1 already gone").
    public let summary: String?
    /// The ways out the person picks from before confirming; empty shows none, the first is picked.
    public let disposals: [ApprovalChoice]
    /// The keys that work ("Esc denies · Space previews"), under the buttons.
    public let hint: String?
    /// Rows carry a checkbox, all on at first; `selected` holds the ids of the rows still on.
    public let selectable: Bool
    /// The title for the rows still selected ("Delete 3 of 5 items for shop?"); nil keeps `title`.
    public var titleForSelection: ((_ selected: Int, _ total: Int) -> String)?

    @Published public var rememberIndex = 0
    @Published public var showsDetails = false
    @Published public private(set) var answered = false
    @Published public var disposal: String
    @Published public var selected: Set<String>
    /// The person's words on a deny ("keep it, my notes"), read by the host in `onDeny`.
    @Published public var denyNote = ""
    /// "Deny…" was pressed: the note field is open.
    @Published public var denying = false
    @Published public private(set) var finish: ApprovalFinish?

    public var onAllow: @MainActor (ApprovalRemember?) -> Void = { _ in }
    public var onDeny: @MainActor () -> Void = {}
    /// The verifier confirmed the person: `method` is "touch-id" or "password".
    public var onVerified: @MainActor (_ method: String, ApprovalRemember?) -> Void = { _, _ in }

    public init(title: String, purpose: String, command: String? = nil, symbol: String, facts: [ApprovalFact], details: [ApprovalFact],
                warning: String?, footnote: String, rememberChoices: [ApprovalRemember], rememberNote: String?,
                allowTitle: String, deadline: Date?, identifier: String, items: [ApprovalItem] = [],
                verifier: ApprovalVerifier? = nil, links: [ApprovalLink] = [], summary: String? = nil,
                disposals: [ApprovalChoice] = [], hint: String? = nil, selectable: Bool = false) {
        self.title = title
        self.purpose = purpose
        self.command = command
        self.symbol = symbol
        self.facts = facts
        self.details = details
        self.warning = warning
        self.footnote = footnote
        self.rememberChoices = rememberChoices
        self.rememberNote = rememberNote
        self.allowTitle = allowTitle
        self.deadline = deadline
        self.identifier = identifier
        self.items = items
        self.verifier = verifier
        self.links = links
        self.summary = summary
        self.disposals = disposals
        self.hint = hint
        self.selectable = selectable
        self.disposal = disposals.first?.id ?? ""
        self.selected = Set(items.map(\.id))
        verifier?.onVerified = { [weak self] method in self?.verified(method: method) }
    }

    /// The title with the live count when rows can be unticked.
    public var displayTitle: String {
        guard selectable, let titleForSelection else { return title }
        return titleForSelection(selected.count, items.count)
    }

    /// The rows still on, in their order.
    public var selectedItems: [ApprovalItem] {
        items.filter { selected.contains($0.id) }
    }

    public func allow() {
        guard !answered else { return }
        answered = true
        onAllow(rememberChoices.indices.contains(rememberIndex) ? rememberChoices[rememberIndex] : nil)
    }

    public func deny() {
        guard !answered else { return }
        answered = true
        verifier?.cancel()
        onDeny()
    }

    /// Opens the deny note; a second press with the note open denies with it. While the note is open the sensor
    /// pauses, so a touch meant for nothing in particular cannot approve what the person is about to deny.
    public func denyWithNote() {
        if denying {
            deny()
        } else {
            denying = true
            verifier?.pause(reason: "deny-note")
        }
    }

    /// Closes the deny note without denying; the sensor listens again when a row is still ticked.
    public func cancelDenyNote() {
        guard denying else { return }
        denying = false

        // With every row unticked the sensor stays paused for that reason (`setSelected`).
        if !(selectable && selected.isEmpty) {
            verifier?.resume()
        }
    }

    /// The host says what happens now; the footer shows it until the window closes.
    public func finished(_ finish: ApprovalFinish) {
        self.finish = finish
    }

    /// Ticks or unticks a row; with nothing ticked the sensor pauses, and it listens again with the first tick.
    public func setSelected(_ item: ApprovalItem, _ on: Bool) {
        if on {
            selected.insert(item.id)
        } else {
            selected.remove(item.id)
        }

        // Nothing picked: the sensor must not approve an empty request; it listens again once a row is on.
        if selected.isEmpty {
            verifier?.pause()
        } else if selected.count == 1, on {
            verifier?.resume()
        }
    }

    private func verified(method: String) {
        // A reply that lands while the deny note is open is late: the sensor was paused for the note.
        guard !answered, !denying else { return }
        answered = true
        onVerified(method, rememberChoices.indices.contains(rememberIndex) ? rememberChoices[rememberIndex] : nil)
    }
}

/// Laid out like a macOS alert: the app icon with the request's symbol, a short title, the reason as the first line a
/// reader sees, a column of facts, the rest folded, and the buttons on the trailing edge with the default last.
public struct ApprovalDialogView: View {
    @ObservedObject package var model: ApprovalDialogModel
    /// The row under the pointer, for the space bar's Quick Look.
    @State private var hoveredPath: String?

    public init(model: ApprovalDialogModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                icon
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.displayTitle)
                        .font(.system(size: 13, weight: .semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text(model.purpose)
                        .font(.system(size: 12))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    if let command = model.command {
                        ApprovalCommandText(command: command).padding(.top, 3)
                    }
                    if !model.links.isEmpty {
                        links.padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !model.facts.isEmpty {
                facts(model.facts)
                    .padding(.leading, 66)
            }

            if !model.items.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ApprovalItemList(items: model.items, identifier: model.identifier,
                                     selection: model.selectable ? selectionBinding : nil, hovered: $hoveredPath)
                    if let summary = model.summary {
                        Text(summary)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .padding(.top, 4)
                            .accessibilityIdentifier("\(model.identifier)-summary")
                    }
                }
                .padding(.leading, 66)
            }

            if !model.details.isEmpty {
                GenDisclosure(isExpanded: $model.showsDetails, minHeight: 22, identifier: "\(model.identifier)-details") {
                    facts(model.details)
                        .padding(.leading, 18)
                        .padding(.top, 2)
                } label: {
                    Text("Details")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, 66)
            }

            if let warning = model.warning {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 66)
                    .accessibilityIdentifier("\(model.identifier)-warning")
            }

            if !model.disposals.isEmpty {
                disposals
            }

            Text(model.footnote)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 66)

            remember
            if let finish = model.finish {
                ApprovalFinishedFooter(model: model, finish: finish)
            } else if let verifier = model.verifier {
                ApprovalVerifyFooter(model: model, verifier: verifier)
            } else {
                buttons
            }
        }
        .padding(20)
        // Rows with a name, a folder and three buttons need the room; a request of facts keeps the alert's width.
        .frame(width: model.items.isEmpty ? 480 : 580)
        // The hidden title bar is no safe area (`safeAreaRegions = []` on the hosting controller), so the dialog
        // uses the full height and the panel's fitting size is the view's own; the strip stays draggable through
        // `.titlebarZone()`.
        .focusable()
        .focusEffectDisabled()
        .onKeyPress(.space) {
            guard let path = hoveredPath, let item = model.items.first(where: { $0.id == path }), !item.gone else {
                return .ignored
            }

            ApprovalQuickLook.toggle(item.location)
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(model.identifier)
    }

    private var selectionBinding: Binding<Set<String>> {
        Binding(get: { model.selected }, set: { next in
            for item in model.items where model.selected.contains(item.id) != next.contains(item.id) {
                model.setSelected(item, next.contains(item.id))
            }
        })
    }

    private var icon: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(nsImage: NSApp?.applicationIconImage ?? NSImage())
                .resizable()
                .frame(width: 52, height: 52)
            Image(systemName: model.symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.orange))
                .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
                .offset(x: 4, y: 4)
        }
        .frame(width: 56, height: 56, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private var links: some View {
        HStack(spacing: 14) {
            ForEach(model.links) { link in
                Button(action: link.action) {
                    Label(link.title, systemImage: link.symbol)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityIdentifier("\(model.identifier)-link-\(link.title.lowercased().replacingOccurrences(of: " ", with: "-"))")
            }
        }
        .disabled(model.answered)
    }

    private func facts(_ rows: [ApprovalFact]) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 5) {
            ForEach(rows) { fact in
                GridRow {
                    Text(fact.label)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .gridColumnAlignment(.trailing)
                    Text(verbatim: fact.value)
                        .font(fact.monospaced ? .system(size: 11, design: .monospaced) : .system(size: 12))
                        .foregroundStyle(fact.dimmed ? Color.secondary : Color.primary)
                        .lineLimit(3)
                        .truncationMode(.middle)
                        // Without it the grid measured one line and cut a path in the middle while the window had room.
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .help(fact.help ?? fact.value)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// The ways out, as radio buttons: the first is picked, and the touch applies the picked one.
    private var disposals: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(model.disposals) { choice in
                Button {
                    model.disposal = choice.id
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: model.disposal == choice.id ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 12))
                            .foregroundStyle(model.disposal == choice.id ? Color.accentColor : Color.secondary)
                        Text(choice.title)
                            .font(.system(size: 12))
                        if let detail = choice.detail {
                            Text(detail)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityAddTraits(model.disposal == choice.id ? [.isSelected] : [])
                .accessibilityIdentifier("\(model.identifier)-disposal-\(choice.id)")
            }
        }
        .padding(.leading, 66)
        .disabled(model.answered)
    }

    /// Its own row, so the buttons keep their full titles (the first layout cut "Allow with Touch ID" short).
    @ViewBuilder
    private var remember: some View {
        if model.rememberChoices.count > 1 {
            HStack(spacing: 8) {
                Text("Remember")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Picker("Remember", selection: $model.rememberIndex) {
                    ForEach(model.rememberChoices.indices, id: \.self) { index in
                        Text(model.rememberChoices[index].title).tag(index)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
                .accessibilityIdentifier("\(model.identifier)-remember")
            }
            .padding(.leading, 66)
            .disabled(model.answered)
            .environment(\.controlActiveState, .key)
        } else if let note = model.rememberNote {
            Label(note, systemImage: "clock.badge.xmark")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.leading, 66)
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            if let deadline = model.deadline {
                (Text("Denies itself in ") + Text(timerInterval: Date()...max(Date(), deadline), countsDown: true))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            Button("Deny", action: model.deny)
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("\(model.identifier)-deny")
            Button(model.allowTitle, action: model.allow)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .fixedSize()
                .accessibilityIdentifier("\(model.identifier)-allow")
        }
        .controlSize(.regular)
        .disabled(model.answered)
        // The panel is non-activating, so its app is never active while it shows; AppKit then greys the prominent
        // button and the main action looks like the others (the permission dialog's live check, 2026-10-10).
        .environment(\.controlActiveState, .key)
    }
}

/// The footer of a window that confirms with Touch ID in place: Apple's glyph with what it waits for, the countdown,
/// and the ways out. No button approves on Return (a stray Return must never delete), Esc denies.
struct ApprovalVerifyFooter: View {
    @ObservedObject var model: ApprovalDialogModel
    @ObservedObject var verifier: ApprovalVerifier
    @FocusState private var noteFocused: Bool

    var body: some View {
        ApprovalFooterLayout(identifier: model.identifier, headline: headline) {
            sensor
        } detail: {
            if let message {
                Text(message.text)
                    .font(.system(size: 11))
                    .foregroundStyle(message.isProblem ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                if let deadline = model.deadline {
                    (Text("Denies itself in ") + Text(timerInterval: Date()...max(Date(), deadline), countsDown: true))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let hint = model.hint {
                    Text(verbatim: "· \(hint)")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
        } trailing: {
            if model.denying {
                denyNote
            } else {
                buttons
            }
        }
        // Esc denies at once, with the note open or not: the Deny… button only opens the note.
        .background {
            Button("Deny", action: model.deny)
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        .disabled(model.answered)
    }

    @ViewBuilder
    private var sensor: some View {
        switch verifier.state {
        case .unavailable, .password:
            ApprovalStateGlyph(symbol: "lock.fill", size: 18, style: .secondary)
        case .paused:
            ApprovalStateGlyph(symbol: "checklist", size: 18, style: .secondary)
        case .verified:
            ApprovalStateGlyph<Color>.approved
        default:
            ApprovalTouchIDGlyph(verifier: verifier)
                .frame(width: 32, height: 32)
                .accessibilityLabel("Touch ID")
        }
    }

    private var headline: String {
        switch verifier.state {
        case .idle, .listening, .failed: return "Touch ID to approve"
        case .paused: return "Nothing selected"
        case .password: return "Waiting for your password"
        case .unavailable: return "Approve with your password"
        case .verified: return "Approved"
        }
    }

    private var message: (text: String, isProblem: Bool)? {
        switch verifier.state {
        case .failed(let text): return (text, true)
        case .unavailable(let text): return (text, false)
        case .paused: return ("Tick at least one row, or deny.", false)
        case .password: return ("The system asks for your password in its own window.", false)
        default: return nil
        }
    }

    /// The deny note: one line the agent reads, Deny sends it, Cancel keeps the request open.
    private var denyNote: some View {
        HStack(spacing: 8) {
            TextField("Why? The agent reads it", text: $model.denyNote)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
                .frame(width: 220)
                .focused($noteFocused)
                .onSubmit(model.deny)
                .accessibilityIdentifier("\(model.identifier)-deny-note")
            Button("Deny", action: model.deny)
                .pointerCursor()
                .accessibilityIdentifier("\(model.identifier)-deny")
            Button("Cancel", action: model.cancelDenyNote)
                .pointerCursor()
                .accessibilityIdentifier("\(model.identifier)-deny-cancel")
        }
        .fixedSize()
        .controlSize(.regular)
        .environment(\.controlActiveState, .key)
        .onAppear { noteFocused = true }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            if case .failed = verifier.state {
                Button("Try again", action: verifier.retry)
                    .pointerCursor()
                    .accessibilityIdentifier("\(model.identifier)-retry")
            }
            if case .unavailable = verifier.state {
                Button("Approve with password…", action: verifier.usePassword)
                    .buttonStyle(.borderedProminent)
                    .pointerCursor()
                    .accessibilityIdentifier("\(model.identifier)-password")
            } else {
                Button("Use password…", action: verifier.usePassword)
                    .disabled(verifier.state == .password || verifier.state == .paused)
                    .pointerCursor(verifier.state != .password)
                    .accessibilityIdentifier("\(model.identifier)-password")
            }
            Button("Deny…", action: model.denyWithNote)
                .pointerCursor()
                .help("Deny, with a word for the agent. Esc denies at once.")
                .accessibilityIdentifier("\(model.identifier)-deny")
        }
        .fixedSize()
        .controlSize(.regular)
        // The panel is non-activating, so its app is never active while it shows; keep the key look (see `buttons`).
        .environment(\.controlActiveState, .key)
    }
}

/// The footer after the answer: what happens now, and a command to copy.
struct ApprovalFinishedFooter: View {
    @ObservedObject var model: ApprovalDialogModel
    let finish: ApprovalFinish

    var body: some View {
        ApprovalFooterLayout(identifier: model.identifier, headline: finish.headline) {
            ApprovalStateGlyph<Color>.approved
        } detail: {
            Text(finish.detail)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } trailing: {
            if let copy = finish.copy {
                Button {
                    Clipboard.copy(copy, what: "command")
                } label: {
                    Label(copy, systemImage: "doc.on.doc")
                        .font(.system(size: 11, design: .monospaced))
                        .lineLimit(1)
                }
                .pointerCursor()
                .help("Copy the command")
                .accessibilityIdentifier("\(model.identifier)-copy")
            }
        }
        .controlSize(.regular)
        .environment(\.controlActiveState, .key)
    }
}

/// The frame both approval footers share: a divider to the window's edges, the 32-pt state glyph, the headline (its
/// `-verify-state` identifier) over the detail lines, and the trailing controls.
struct ApprovalFooterLayout<Icon: View, Detail: View, Trailing: View>: View {
    let identifier: String
    let headline: String
    let icon: Icon
    let detail: Detail
    let trailing: Trailing

    init(identifier: String, headline: String, @ViewBuilder icon: () -> Icon, @ViewBuilder detail: () -> Detail,
         @ViewBuilder trailing: () -> Trailing) {
        self.identifier = identifier
        self.headline = headline
        self.icon = icon()
        self.detail = detail()
        self.trailing = trailing()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider().padding(.horizontal, -20)
            HStack(alignment: .center, spacing: 12) {
                icon
                VStack(alignment: .leading, spacing: 2) {
                    Text(headline)
                        .font(.system(size: 13, weight: .semibold))
                        .accessibilityIdentifier("\(identifier)-verify-state")
                    detail
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                trailing
            }
        }
    }
}

/// A footer's state glyph: an SF Symbol in the 32-pt square the Touch ID glyph takes, hidden from VoiceOver (the
/// headline says the state).
struct ApprovalStateGlyph<Style: ShapeStyle>: View {
    let symbol: String
    let size: CGFloat
    let style: Style

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(style)
            .frame(width: 32, height: 32)
            .accessibilityHidden(true)
    }
}

extension ApprovalStateGlyph where Style == Color {
    /// The green check of an approved request.
    static var approved: ApprovalStateGlyph<Color> {
        ApprovalStateGlyph(symbol: "checkmark.circle.fill", size: 22, style: .green)
    }
}

/// One floating panel for one request. It never runs a modal session (a modal loop on the main queue stops every
/// timer queued there, so a deadline never fired), never activates its app, and takes the keyboard only after the
/// user clicks into it: a request that pops up while someone types must not catch a stray Return. So that it is not
/// missed, it plays a sound and speaks to VoiceOver when it appears, and a notification follows while it waits
/// (`ApprovalAttention`, both settings).
@MainActor
public final class ApprovalPanelPresenter: NSObject, NSWindowDelegate {
    private var panel: NSPanel?
    private var model: ApprovalDialogModel?
    private var reminder: ApprovalReminder?

    public override init() {}

    public func present(_ model: ApprovalDialogModel) {
        if NSApp == nil { _ = NSApplication.shared }
        let controller = NSHostingController(rootView: ApprovalDialogView(model: model).titlebarZone())
        // No safe area for the hidden title bar: with it, `.ignoresSafeArea()` drew the view from the top, but the
        // fitting size still carried the bar's 28 pt, which sat as an empty band under the buttons (2026-10-30).
        controller.safeAreaRegions = []
        // The panel follows the view's size, so opening Details grows it and closing shrinks it back.
        controller.sizingOptions = [.preferredContentSize]
        let size = controller.view.fittingSize
        let panel = ApprovalPanel(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.title = model.title
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        // After isFloatingPanel, whose setter resets the level: above the widget's panels, as the permission dialog.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.animationBehavior = .alertPanel
        panel.contentViewController = controller
        panel.delegate = self
        panel.setAccessibilityIdentifier(model.identifier)
        panel.setFrameOrigin(Self.origin(for: size))
        self.panel = panel
        self.model = model
        panel.orderFrontRegardless()
        let reminder = ApprovalReminder(model: model) { [weak self] in self?.bringForward() }
        self.reminder?.stop()
        self.reminder = reminder
        reminder.start()
    }

    public func close() {
        model?.verifier?.cancel()
        reminder?.stop()
        reminder = nil
        panel?.delegate = nil
        panel?.orderOut(nil)
        panel = nil
    }

    /// The request is answered and the window stays a moment to say what happens (`ApprovalFinish`): the reminder
    /// stops now, the panel closes after `seconds`.
    public func linger(seconds: TimeInterval, then done: @escaping @MainActor () -> Void) {
        reminder?.stop()
        reminder = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            MainActor.assumeIsolated {
                self?.close()
                done()
            }
        }
    }

    /// A click on the reminder: the panel moves to the screen under the pointer and comes to the front, still without
    /// taking the keyboard.
    private func bringForward() {
        guard let panel, model?.answered == false else { return }
        panel.setFrameOrigin(Self.origin(for: panel.frame.size))
        panel.orderFrontRegardless()
    }

    /// ⌘W answers the way Deny does.
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        model?.deny()
        return false
    }

    /// Horizontally centred in the upper fifth of the screen under the pointer, where macOS puts an alert.
    private static func origin(for size: CGSize) -> CGPoint {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let top = visible.maxY - visible.height * 0.2
        return CGPoint(x: (visible.midX - size.width / 2).rounded(), y: (top - size.height).rounded())
    }
}

/// A titled panel that can take the keyboard without activating its app.
private final class ApprovalPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
