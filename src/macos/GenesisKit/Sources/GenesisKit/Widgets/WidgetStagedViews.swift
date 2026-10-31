import SwiftUI

/// A decision's staged pick or note, as one line: "a) Back both up" or the note.
enum WidgetStagedText {
    static func line(_ item: WidgetInboxItem, option: String?) -> String {
        let options = item.options ?? []
        // Every staged letter with its own text: a ⇧-pick in the hub stores "ac", which read "ac) <text of a>" (F14).
        let picks = (option ?? "").compactMap { letter -> String? in
            guard let index = letter.unicodeScalars.first.map({ Int($0.value) - 97 }), options.indices.contains(index)
            else { return nil }
            // The option's own "b) " is dropped: the line read "b) b) drop it" (UX audit F1).
            return "\(letter)) " + WidgetOptionText.text(options[index], letter: String(letter))
        }
        guard !picks.isEmpty else { return item.draft ?? "Nothing picked" }
        return picks.joined(separator: " / ") + (item.draft.map { " · " + $0 } ?? "")
    }
}

extension WidgetModel {
    /// The pick a view draws as staged: none while a discard of it waits for its Undo note (`heldDecisionIDs`), so a
    /// discarded decision does not still read "Staged" elsewhere for those seconds.
    func shownStagedOption(_ sourceId: String, stored: String?) -> String? {
        heldDecisionIDs.contains(sourceId) ? nil : stagedOption(sourceId, stored: stored)
    }

    /// The staged note a view draws, with the same rule.
    func shownStagedNote(_ sourceId: String, _ draft: String?) -> String? {
        heldDecisionIDs.contains(sourceId) ? nil : draft
    }
}

/// The row under a session inbox's filter that says what is staged and opens the staged view.
struct WidgetStagedChip: View {
    @ObservedObject var model: WidgetModel
    @GenReduceMotion private var reduceMotion

    /// "2 decisions staged (1 in this session, 1 to report-2026-09)": where the staged decisions go, so a count with
    /// nothing staged in the list below says which session holds them (Martin, 2026-10-28).
    static func summary(_ items: [WidgetInboxItem], here: String, title: (String) -> String?) -> String {
        let total = Plural.count(items.count, "decision") + " staged"
        var order: [String] = []
        var counts: [String: Int] = [:]
        for item in items {
            if counts[item.key] == nil { order.append(item.key) }
            counts[item.key, default: 0] += 1
        }
        if order == [here] { return total + " in this session" }
        let parts = order.sorted { ($0 == here ? 0 : 1) < ($1 == here ? 0 : 1) }.map { key in
            let count = counts[key] ?? 0
            return key == here ? "\(count) in this session" : "\(count) to \(title(key) ?? "another session")"
        }
        return total + " (" + parts.joined(separator: ", ") + ")"
    }

    var body: some View {
        let here = model.sessionStaged.count
        let all = model.stagedItems.count
        if all > 0 {
            HStack(spacing: 8) {
                Image(systemName: "tray.and.arrow.up").font(.system(size: 11)).foregroundStyle(SessionPalette.blue)
                Text(Self.summary(model.stagedItems, here: model.selectedKey) { model.session(forKey: $0)?.title })
                    .font(.system(size: 11, weight: .medium)).lineLimit(2)
                Spacer(minLength: 4)
                // Send skips the review: the same decisions Review and send would list, all of them checked.
                let ready = here > 0 ? model.sessionStaged : model.stagedItems
                let sending = ready.allSatisfy { model.sendingDecisionIDs.contains($0.sourceId) }
                Button(sending ? "Sending…" : "Send") {
                    model.sendStaged(ready.map(\.sourceId), known: ready)
                }
                .buttonStyle(.genHover(accent: SessionPalette.blue)).font(.system(size: 11, weight: .semibold))
                .disabled(sending)
                .accessibilityIdentifier("widget.staged.send")
                .instantTooltip(here > 0 && here < all
                    ? "Sends the \(Plural.count(here, "decision")) staged here now, without the review"
                    : "Sends the staged decisions now, without the review, one message per session")
                Button("Review and send") {
                    GenMotion.perform(expanding: true, reduceMotion: reduceMotion) {
                        model.stagedView = here > 0 ? "session" : "all"
                    }
                }
                .buttonStyle(.genHover(accent: SessionPalette.blue)).font(.system(size: 11, weight: .semibold))
                .instantTooltip("The picks and notes you staged. Choose which go now; each session gets one message.")
                .accessibilityIdentifier("widget.staged.review")
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(SessionPalette.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
            // `.contain`, not `.combine`: combined, VoiceOver and automation saw one element and could press neither
            // Send nor Review and send.
            .accessibilityElement(children: .contain)
        }
    }
}

/// The staged decisions, with a checkbox each: the checked ones go now, one message per session. "This session"
/// shows the selected session's; "All sessions" every one (Martin, 2026-10-23: "an easy button which shows all of
/// them not just the filtered by that specific session").
struct WidgetStagedList: View {
    @ObservedObject var model: WidgetModel
    @GenReduceMotion private var reduceMotion
    /// Unchecked decision ids; everything else is checked, so a newly staged one goes by default.
    @State private var skipped: Set<String> = []
    /// The rows opened to show their decision and options.
    @State private var openIDs: Set<String> = []

    private var scopeAll: Bool { model.stagedView == "all" || model.sessionStaged.isEmpty }
    private var items: [WidgetInboxItem] { scopeAll ? model.stagedItems : model.sessionStaged }
    private var chosen: [WidgetInboxItem] { items.filter { !skipped.contains($0.sourceId) } }

    var body: some View {
        let items = items
        let chosen = chosen
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                IconButton(systemName: "chevron.left", tooltip: "Back to the inbox") {
                    GenMotion.perform(expanding: false, reduceMotion: reduceMotion) { model.stagedView = nil }
                }
                .accessibilityLabel("Back to the inbox")
                .accessibilityIdentifier("widget.staged.back")
                Text("Staged decisions").font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 4)
                if !model.sessionStaged.isEmpty && model.sessionStaged.count < model.stagedItems.count {
                    GenSegmentedTabs(
                        "Staged scope",
                        items: [.init("session", "This session"), .init("all", "All sessions (\(model.stagedItems.count))")],
                        selection: Binding(get: { scopeAll ? "all" : "session" }, set: { model.stagedView = $0 }),
                        minSegmentWidth: 90, identifier: "widget.staged.scope")
                }
            }
            if items.isEmpty {
                Text("Nothing is staged. A click on a decision's option stages it here.")
                    .font(.caption).foregroundStyle(.secondary).padding(.vertical, 20).frame(maxWidth: .infinity)
            } else {
                ForEach(groups(items), id: \.key) { group in
                    VStack(alignment: .leading, spacing: 6) {
                        if scopeAll {
                            Text(model.session(forKey: group.key)?.title ?? "Unknown session")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                        }
                        ForEach(group.items, id: \.sourceId) { item in
                            WidgetStagedDecisionRow(model: model, item: item, openIDs: $openIDs, checked: Binding(
                                get: { !skipped.contains(item.sourceId) },
                                set: { if $0 { skipped.remove(item.sourceId) } else { skipped.insert(item.sourceId) } }))
                        }
                    }
                }
                Text(chosen.isEmpty ? "Nothing is checked." : WidgetModel.stagedSummary(chosen))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Button("Send \(chosen.count) now") {
                        // The pane keeps its height while the staged list closes, so the panel does not shrink
                        // away from the pointer (hover hunt H2, 2026-10-25).
                        model.holdAgentFit()
                        model.sendStaged(chosen.map(\.sourceId))
                        model.stagedView = nil
                    }
                    // Drawn by the kit, not `.borderedProminent`: in the non-activating panel the native one is grey.
                    .buttonStyle(.genPrimary()).disabled(chosen.isEmpty)
                    // The leave question over this list owns ⌘↩ while it is shown.
                    .keyboardShortcut(model.stagedLeavePrompt ? nil : KeyboardShortcut(.return, modifiers: [.command]))
                    .instantTooltip("Sends the checked decisions now, one message per session (⌘↩)")
                    Button("Discard checked") {
                        // Held behind an Undo note (`holdDiscard`): the notes typed into these decisions are gone
                        // after it, so the discard waits, as the leave question's Discard does (UX audit F21).
                        model.holdDiscard(chosen.map(\.sourceId))
                    }
                        .buttonStyle(.genHover()).disabled(chosen.isEmpty)
                        .instantTooltip("Clears the picks and notes; the decisions still wait for an answer. Undo brings them back.")
                    Spacer(minLength: 0)
                    Button("Keep staged") {
                        GenMotion.perform(expanding: false, reduceMotion: reduceMotion) { model.stagedView = nil }
                    }.buttonStyle(.genHover())
                }.font(.caption)
            }
        }
        .padding(12)
        .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
    }

    private func groups(_ items: [WidgetInboxItem]) -> [(key: String, items: [WidgetInboxItem])] {
        var order: [String] = []
        var byKey: [String: [WidgetInboxItem]] = [:]
        for item in items {
            if byKey[item.key] == nil { order.append(item.key) }
            byKey[item.key, default: []].append(item)
        }
        return order.map { ($0, byKey[$0] ?? []) }
    }
}

/// The question before the panel closes with staged decisions: "You have 3 decisions staged. What to do with them?"
/// It lists them, and a click on one opens it here to change its pick. A click beside the box, Dismiss or the close
/// button leaves the question and keeps the panel open, as it was (Martin, 2026-10-28).
struct WidgetStagedLeavePrompt: View {
    @ObservedObject var model: WidgetModel
    @State private var openIDs: Set<String> = []

    var body: some View {
        // `stagedForLeave`, as the question itself counts: a pick made a moment before Esc is not listed yet.
        let items = model.stagedForLeave
        ZStack {
            Color.black.opacity(0.35)
                .contentShape(Rectangle())
                .onTapGesture { model.resolveStagedLeave("stay") }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 8) {
                    Text("You have \(Plural.count(items.count, "decision")) staged. What to do with \(items.count == 1 ? "it" : "them")?")
                        .font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    IconButton(systemName: "xmark", tooltip: "Close this question and stay where you are") {
                        model.resolveStagedLeave("stay")
                    }
                    .accessibilityLabel("Close this question and stay")
                    .accessibilityIdentifier("widget.leave.close")
                }
                Text(WidgetModel.stagedSummary(items) + (items.count == 1 ? " if you send it now." : " if you send them now."))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                FittedScroll(maxHeight: 260) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(items, id: \.sourceId) { item in
                            WidgetStagedDecisionRow(model: model, item: item, openIDs: $openIDs)
                        }
                    }
                }
                // Return and Esc keep the answers (the safe choice); sending cannot be undone, so it needs ⌘↩ or a click.
                HStack(spacing: 8) {
                    Button("Keep staged (send later)") { model.resolveStagedLeave("keep") }
                        .buttonStyle(.genPrimary()).keyboardShortcut(.defaultAction)
                        .instantTooltip("Closes the panel; the decisions stay staged for later (↩)")
                    Button("Send now") { model.resolveStagedLeave("send") }
                        .accessibilityIdentifier("widget.leave.send")
                        .buttonStyle(.genHover(accent: SessionPalette.blue))
                        .keyboardShortcut(.return, modifiers: [.command])
                        .instantTooltip("Sends them now, one message per session (⌘↩)")
                    Button("Discard") { model.resolveStagedLeave("discard") }
                        .buttonStyle(.genHover(accent: .red))
                        .instantTooltip("Clears the picks and notes; the decisions still wait for an answer.")
                }.font(.caption)
                HStack(spacing: 8) {
                    Button("Review them first") {
                        model.stagedLeavePrompt = false
                        model.stagedView = "all"
                    }.buttonStyle(.genHoverPlain())
                    Spacer(minLength: 0)
                    Button("Dismiss") { model.resolveStagedLeave("stay") }
                        .accessibilityIdentifier("widget.leave.dismiss")
                        .buttonStyle(.genHoverPlain()).foregroundStyle(.secondary)
                        .instantTooltip("Closes this question; the panel stays open and nothing changes.")
                }.font(.caption)
            }
            .padding(16).frame(maxWidth: 420)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.12)))
            .shadow(radius: 18)
        }
        .transition(.opacity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Staged decisions before closing")
    }
}

/// One staged decision: its title and what is staged. A click opens it to show the decision and its options, and a
/// click on an option changes the pick (the shared option row, as the inbox of every session draws it). The Review
/// list adds a checkbox that chooses whether it goes now; the leave question has none.
struct WidgetStagedDecisionRow: View {
    // lint-rules-ignore: a few rows (the staged decisions), observes on purpose
    @ObservedObject var model: WidgetModel
    let item: WidgetInboxItem
    @Binding var openIDs: Set<String>
    var checked: Binding<Bool>? = nil
    @GenReduceMotion private var reduceMotion

    var body: some View {
        let open = openIDs.contains(item.sourceId)
        let title = WidgetInboxOverview.title(item)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 9) {
                if let checked {
                    // lint-rules-ignore: short list (the staged decisions, a few rows)
                    Button {
                        checked.wrappedValue.toggle()
                    } label: {
                        Image(systemName: checked.wrappedValue ? "checkmark.square.fill" : "square")
                            .foregroundStyle(checked.wrappedValue ? SessionPalette.blue : .secondary).font(.system(size: 13))
                            .frame(width: 18, height: 18).contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverIcon(diameter: 22))
                    .instantTooltip(checked.wrappedValue ? "Goes with this send; click to keep it staged"
                                                         : "Stays staged; click to send it with the others")
                    .accessibilityLabel("Send " + title + " now")
                    .accessibilityValue(checked.wrappedValue ? "Will be sent" : "Stays staged")
                    .accessibilityIdentifier("widget.staged.check." + item.sourceId)
                }
                Button {
                    GenMotion.perform(expanding: !open, reduceMotion: reduceMotion) {
                        if open { openIDs.remove(item.sourceId) } else { openIDs.insert(item.sourceId) }
                    }
                } label: {
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title).font(.system(size: 12, weight: .medium)).lineLimit(open ? nil : 2)
                            Text(WidgetStagedText.line(item, option: model.shownStagedOption(item.sourceId, stored: item.draftOption)))
                                .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(open ? nil : 2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.tertiary).rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                .accessibilityHint("Shows the decision and its options")
                .accessibilityIdentifier("widget.staged.row." + item.sourceId)
            }
            .padding(8)
            if open {
                detail.padding(.horizontal, 10).padding(.bottom, 10).transition(.genReveal)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .background(Color.white.opacity(open ? 0.055 : 0), in: RoundedRectangle(cornerRadius: 8))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .modifier(RowHover())
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let body = model.card(for: item)?.body, !body.isEmpty {
                WidgetMarkdown(text: body)
            }
            if let options = item.options, !options.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                        WidgetItemOptionButton(model: model, item: item, index: index, option: option)
                    }
                }
            }
            Button("Open in its session") {
                model.stagedLeavePrompt = false
                model.openInboxItem(item)
            }
            .buttonStyle(.genHoverPlain()).font(.system(size: 11))
            .instantTooltip("Opens the decision in its session, with its own answer field")
        }
    }
}

/// The soft fill a list row gets under the pointer, for a row made of several buttons.
private struct RowHover: ViewModifier {
    @State private var hovered = false

    func body(content: Content) -> some View {
        content
            .background(Color.white.opacity(hovered ? 0.04 : 0), in: RoundedRectangle(cornerRadius: 8))
            .onHover { hovered = $0 }
    }
}
