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

    var body: some View {
        let here = model.sessionStaged.count
        let all = model.stagedItems.count
        if all > 0 {
            HStack(spacing: 8) {
                Image(systemName: "tray.and.arrow.up").font(.system(size: 11)).foregroundStyle(SessionPalette.blue)
                Text(here > 0 && here < all ? "\(Plural.count(here, "decision")) staged here · \(all) in all"
                     : "\(Plural.count(all, "decision")) staged")
                    .font(.system(size: 11, weight: .medium))
                Spacer(minLength: 4)
                Button("Review and send") {
                    GenMotion.perform(expanding: true, reduceMotion: reduceMotion) {
                        model.stagedView = here > 0 ? "session" : "all"
                    }
                }
                .buttonStyle(.genHover(accent: SessionPalette.blue)).font(.system(size: 11, weight: .semibold))
                .instantTooltip("The picks and notes you staged. Choose which go now; each session gets one message.")
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(SessionPalette.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
            .accessibilityElement(children: .combine)
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
                }.accessibilityLabel("Back to the inbox")
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
                        ForEach(group.items, id: \.sourceId) { item in row(item) }
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

    private func row(_ item: WidgetInboxItem) -> some View {
        let checked = !skipped.contains(item.sourceId)
        return Button {
            if checked { skipped.insert(item.sourceId) } else { skipped.remove(item.sourceId) }
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .foregroundStyle(checked ? SessionPalette.blue : .secondary).font(.system(size: 13))
                VStack(alignment: .leading, spacing: 2) {
                    Text(WidgetInboxOverview.title(item)).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    Text(WidgetStagedText.line(item, option: model.stagedOption(item.sourceId, stored: item.draftOption)))
                        .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(8).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 8))
        .accessibilityLabel(WidgetInboxOverview.title(item))
        .accessibilityValue(checked ? "Will be sent" : "Stays staged")
    }
}

/// The question before the panel closes with staged decisions: "You have 3 decisions staged. What to do with them?"
struct WidgetStagedLeavePrompt: View {
    @ObservedObject var model: WidgetModel

    var body: some View {
        let items = model.stagedItems
        ZStack {
            Color.black.opacity(0.35).allowsHitTesting(true)
            VStack(alignment: .leading, spacing: 10) {
                Text("You have \(Plural.count(items.count, "decision")) staged. What to do with \(items.count == 1 ? "it" : "them")?")
                    .font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                Text(WidgetModel.stagedSummary(items) + (items.count == 1 ? " if you send it now." : " if you send them now."))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                // Return and Esc keep the answers (the safe choice); sending cannot be undone, so it needs ⌘↩ or a click.
                HStack(spacing: 8) {
                    Button("Keep staged (send later)") { model.resolveStagedLeave("keep") }
                        .buttonStyle(.genPrimary()).keyboardShortcut(.defaultAction)
                        .instantTooltip("Closes the panel; the decisions stay staged for later (↩)")
                    Button("Send now") { model.resolveStagedLeave("send") }
                        .buttonStyle(.genHover(accent: SessionPalette.blue))
                        .keyboardShortcut(.return, modifiers: [.command])
                        .instantTooltip("Sends them now, one message per session (⌘↩)")
                    Button("Discard") { model.resolveStagedLeave("discard") }
                        .buttonStyle(.genHover(accent: .red))
                        .instantTooltip("Clears the picks and notes; the decisions still wait for an answer.")
                }.font(.caption)
                Button("Review them first") {
                    model.stagedLeavePrompt = false
                    model.stagedView = "all"
                }.buttonStyle(.genHoverPlain()).font(.caption)
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
