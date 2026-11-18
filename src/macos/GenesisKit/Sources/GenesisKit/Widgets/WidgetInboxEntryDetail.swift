import SwiftUI

/// The same item opens in the overview and in the hover list. The parent owns selection and keyboard focus.
struct WidgetInboxEntry: View {
    @ObservedObject var model: WidgetModel
    let item: WidgetInboxItem
    let open: Bool
    let focused: Bool
    let grouped: Bool
    var compact = false
    var focusedOption: String?
    var surface: WidgetSurfaceID?
    let toggle: () -> Void

    var body: some View {
        let session = item.message?.origin == nil ? model.session(forKey: item.key) : nil
        VStack(alignment: .leading, spacing: 0) {
            WidgetInboxOverviewRow(
                item: item, open: open, focused: focused, grouped: grouped,
                sessionTitle: item.message?.origin ?? session?.title, stagedLine: stagedLine(item), toggle: toggle)
                .equatable()
            if open {
                WidgetInboxEntryDetail(model: model, item: item, session: session, compact: compact,
                                       focusedOption: focusedOption, focusRow: focused, surface: surface)
                    .padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 12)
                    .transition(.genReveal)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .background(Color.white.opacity(open ? 0.055 : 0.03), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(item.needsAnswer ? Color.orange.opacity(0.28) : .clear, lineWidth: 1))
        // The keyboard's row: a focus ring, the look of the system's own.
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(focused ? Color(nsColor: .keyboardFocusIndicatorColor) : .clear, lineWidth: 2))
        .id(item.id)
    }

    private func stagedLine(_ item: WidgetInboxItem) -> String? {
        let option = model.shownStagedOption(item.sourceId, stored: item.draftOption)
        let note = model.shownStagedNote(item.sourceId, item.draft)
        guard item.kind == "decision", item.needsAnswer, option != nil || note != nil else { return nil }
        return WidgetStagedText.line(item, option: option)
    }
}

struct WidgetInboxEntryDetail: View {
    @ObservedObject var model: WidgetModel
    let item: WidgetInboxItem
    let session: WidgetSession?
    let compact: Bool
    var focusedOption: String?
    var focusRow = false
    var surface: WidgetSurfaceID?
    @State private var earlierOpen = false
    @State private var entries: [WidgetGroupEntry]?
    @State private var groupFailure: String?
    @State private var groupAttempt = 0

    /// An open decision's options, each staging (or sending, by the setting) that pick from here; the shared option
    /// row, so this list, the alert and a session's inbox draw an option one way.
    @ViewBuilder private func choices(_ item: WidgetInboxItem) -> some View {
        if ["decision", "dialog"].contains(item.kind), item.needsAnswer, let options = item.options, !options.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    let letter = WidgetInboxOverview.letter(index)
                    WidgetItemOptionButton(model: model, item: item, index: index, option: option,
                                           focused: focusRow && focusedOption == letter)
                        .id(item.id + "#" + letter)
                }
                // A set's clicks only tick, so its Send lives here, beside the options it sends.
                if item.takesSeveral { setSendBar(item) }
            }
        }
    }

    /// The Send of a decision that takes any set of its options, and its recommended set in one click.
    private func setSendBar(_ item: WidgetInboxItem) -> some View {
        WidgetSetSendBar(
            letters: model.shownStagedOption(item.sourceId, stored: item.draftOption),
            recommended: DecisionAnswering.recommendedSet(item.recommended, count: item.options?.count ?? 0),
            sending: model.sendingDecisionIDs.contains(item.sourceId),
            identifier: "widget.overview.sendSet." + item.sourceId,
            pick: { model.pickSet(item, option: $0) },
            send: { model.sendStaged([item.sourceId], known: [item]) })
            .padding(.top, 2)
    }

    @ViewBuilder private func summary(_ item: WidgetInboxItem) -> some View {
        if model.preferences.overviewSummary, item.needsAnswer,
           let summary = item.summary, !summary.isEmpty {
            WidgetPeekSummary(summary: summary, identifier: "widget.overview.summary").equatable()
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            summary(item)
            if let message = item.message {
                WidgetOverviewMessage(message: message, clamp: compact ? 8 : 14, imageHeight: compact ? 64 : 96,
                                      showMedia: { model.showMedia?($0) }, load: { try await model.messageBody(for: item) })
            } else if let reply = item.reply {
                WidgetReceiptBlock(question: reply.question, preview: reply.text, more: reply.more == true,
                                   headTitle: item.title, label: "Answer", clamp: compact ? 8 : 14,
                                   imageHeight: compact ? 64 : 96, showMedia: { model.showMedia?($0) },
                                   load: { try await model.messageBody(for: item) })
                    .accessibilityIdentifier("widget.overview.answer." + item.id)
                if let count = item.count, count > 1 {
                    earlierAnswers(count - 1)
                }
            } else if item.kind == "decision", !item.needsAnswer, item.option != nil || item.answer != nil {
                let words = [item.option.map { "Answered " + $0.uppercased() }, item.answer]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                WidgetAnswerBlock(question: nil, answer: words, more: false, clampLines: 1,
                                  label: WidgetAlerts.answeredViaText(item.answeredVia))
            }
            choices(item)
            if !compact, let session {
                HStack(spacing: 8) {
                    AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                        Text([session.project, session.visualStatus.label, String(session.target.sessionId.prefix(8))]
                            .filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            HStack(spacing: 8) {
                if item.message?.origin == nil {
                    Button(item.needsAnswer ? "Answer in its session" : "Open in its session") { model.openInboxItem(item, on: surface) }
                        .buttonStyle(.genHover(accent: item.needsAnswer ? .orange : KitTheme.accent))
                        .accessibilityIdentifier("widget.overview.open." + item.id)
                }
                if let session {
                    Button("Whole inbox") { wholeInbox(session) }.buttonStyle(.genHover())
                    Spacer(minLength: 0)
                    WidgetCmuxButton(model: model, session: session, size: 12)
                }
            }.font(.caption)
        }
    }

    private func wholeInbox(_ session: WidgetSession) {
        model.select(session.key)
        model.section = "Inbox"
        if let surface { model.openModule("agents", on: surface) }
    }

    private func earlierAnswers(_ count: Int) -> some View {
        GenDisclosure(Plural.count(count, "earlier answer"), isExpanded: $earlierOpen,
                      identifier: "widget.overview.earlier." + item.id) {
            VStack(alignment: .leading, spacing: 8) {
                if let entries {
                    ForEach(entries) { entry in
                        VStack(alignment: .leading, spacing: 3) {
                            LiveAgo(date: Date(timeIntervalSince1970: entry.at / 1000), style: .brief)
                                .font(.caption2).foregroundStyle(.secondary)
                            WidgetReceiptBlock(question: entry.question, preview: entry.text, more: entry.more == true,
                                               headTitle: nil, label: "Answer", clamp: 4, imageHeight: 56,
                                               showMedia: { model.showMedia?($0) }, earlier: true,
                                               load: { try await model.entryBody(id: entry.id) })
                        }
                    }
                    if entries.isEmpty {
                        Text("No earlier unread answers remain.").font(.caption).foregroundStyle(.secondary)
                    } else if entries.count == 5, count > entries.count, let session {
                        HStack {
                            Text("And \(count - entries.count) more in its session")
                            Button("Whole inbox") { wholeInbox(session) }.buttonStyle(.genHoverPlain())
                        }.font(.caption)
                    }
                } else if let groupFailure {
                    Text("Earlier answers could not be read: \(groupFailure)").font(.caption).foregroundStyle(.secondary)
                    Button("Try again") { groupAttempt += 1 }.buttonStyle(.genHoverPlain())
                } else {
                    ProgressView("Loading earlier answers").controlSize(.small)
                }
            }.task(id: groupAttempt) {
                guard entries == nil else { return }
                groupFailure = nil
                do { entries = try await model.answerGroup(for: item) }
                catch { if !Task.isCancelled { groupFailure = error.localizedDescription } }
            }
        }
    }
}

private struct WidgetOverviewMessage: View {
    let message: WidgetInboxItem.Message
    let clamp: Int
    let imageHeight: CGFloat
    let showMedia: (WidgetMediaSelection) -> Void
    let load: () async throws -> WidgetEntryBody

    var body: some View {
        WidgetReceiptBlock(question: nil, preview: message.text, more: message.more == true, headTitle: nil,
                           label: "Message", clamp: clamp, imageHeight: imageHeight, showMedia: showMedia, load: load)
    }
}

private struct WidgetReceiptBlock: View {
    let question: String?
    let preview: String
    let more: Bool
    let headTitle: String?
    let label: String
    let clamp: Int
    let imageHeight: CGFloat
    let showMedia: (WidgetMediaSelection) -> Void
    var earlier = false
    let load: () async throws -> WidgetEntryBody

    @State private var full: WidgetEntryBody?
    @State private var failure: String?
    @State private var attempt = 0

    private var shownQuestion: String? {
        guard question != nil, let text = full?.question ?? question, !text.isEmpty else { return nil }
        let line = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return earlier || line != headTitle ? text : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            WidgetAnswerBlock(question: shownQuestion, answer: full?.body ?? preview,
                              more: more && full == nil && failure == nil, clampLines: clamp,
                              label: label, earlier: earlier)
                .equatable()
            // The pictures come with the full read: the snapshot carries text only.
            if let images = full?.attachments, !images.isEmpty {
                WidgetCardAttachments(images: images, height: imageHeight, maxWidth: imageHeight * 2.4,
                                      compare: !earlier, showMedia: showMedia)
            }
            if let failure, more {
                Text("The full \(label.lowercased()) could not be read: \(failure)")
                    .font(.caption).foregroundStyle(.secondary)
                // lint-rules-ignore: short list (at most five earlier answers, and only after a failed read)
                Button("Try again") { attempt += 1 }.buttonStyle(.genHoverPlain()).font(.caption)
            }
        }.task(id: attempt) {
            // Every open reads the receipt once: a cut text gets its rest, and any text gets its pictures.
            guard full == nil else { return }
            failure = nil
            do { full = try await load() }
            catch { if !Task.isCancelled { failure = error.localizedDescription } }
        }
    }
}
