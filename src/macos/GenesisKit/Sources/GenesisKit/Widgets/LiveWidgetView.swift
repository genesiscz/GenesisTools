import AppKit
import SwiftUI
import UniformTypeIdentifiers

public struct LiveWidgetView: View {
    @ObservedObject var model: WidgetModel
    let edge: EdgePanelPlacement
    let cutout: CGFloat
    let compactHeight: CGFloat
    private var section: String {
        get { model.section }
        nonmutating set { model.section = newValue }
    }
    @State private var media: WidgetMediaSelection?
    @State private var retry: WidgetOutgoing?
    @FocusState private var editing: Bool

    public init(
        model: WidgetModel, edge: EdgePanelPlacement, cutout: CGFloat = 0, compactHeight: CGFloat = 36
    ) {
        self.model = model
        self.edge = edge
        self.cutout = cutout
        self.compactHeight = compactHeight
    }

    private var items: [AgentWidgetItem] {
        model.sessions.map { session in
            AgentWidgetItem(
                id: session.key, provider: session.target.provider, project: session.project,
                title: session.title, request: "", context: "", question: "", status: session.visualStatus)
        }
    }

    public var body: some View {
        AgentWidgetView(
            placement: edge, items: items, selectedID: model.selectedKey,
            expanded: model.expanded == edge,
            animationsActive: model.placement == "both" || (model.placement == "top" ? edge == .top : edge != .top),
            cutoutWidth: cutout, compactHeight: compactHeight,
            draft: Binding(get: { model.draft.text }, set: model.setText),
            actions: AgentWidgetActions(
                expand: { model.open(edge) }, collapse: model.collapse,
                select: { model.select($0, edge: edge) }, choose: { model.submit(choice: $0) },
                submit: { model.submit() }, settings: { model.showSettings?() }, next: { model.next() }),
            liveContent: AnyView(content)
        )
        .widgetAccessibility(
            reduceMotion: model.reduceMotion, reduceTransparency: model.reduceTransparency
        )
        .sheet(item: $media, onDismiss: { model.dialogOpen = false }) { selection in
            WidgetMediaView(model: model, selection: selection).frame(width: 740, height: 620)
        }
        .alert(
            "Check the conversation before retrying",
            isPresented: Binding(
                get: { retry != nil }, set: { if !$0 { retry = nil } })
        ) {
            Button("Cancel", role: .cancel) { retry = nil }
            Button("I checked — retry") {
                if let retry {
                    model.action(["action": "retry", "id": .string(retry.id), "confirmedUnknown": true])
                }
                retry = nil
            }
        } message: {
            Text("The previous transport did not return a receipt. Retrying may send a second copy.")
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let notice = model.notice {
                HStack {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        model.notice = nil
                    } label: {
                        Image(systemName: "xmark")
                    }.buttonStyle(.plain)
                }
            }
            if let error = model.error {
                HStack(alignment: .top) {
                    Text(error).font(.system(size: 11)).foregroundStyle(.orange).textSelection(.enabled)
                        .lineLimit(4)
                    Spacer(minLength: 4)
                    Button {
                        model.error = nil
                    } label: {
                        Image(systemName: "xmark")
                    }.buttonStyle(.plain)
                }
            }
            if let errors = model.snapshot?.errors, !errors.isEmpty {
                DisclosureGroup("Some sources are unavailable") {
                    Text(errors.joined(separator: "\n")).font(.caption).foregroundStyle(.orange)
                        .textSelection(.enabled)
                }.font(.caption)
            }
            Picker("View", selection: Binding(get: { section }, set: { section = $0 })) {
                Text("Inbox").tag("Inbox")
                Text("Conversation").tag("Conversation")
                if model.snapshot?.state.preferences.showChanges == true { Text("Changes").tag("Changes") }
            }.pickerStyle(.segmented)
            if model.snapshot == nil {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Connecting to your local agents…").font(.callout).foregroundStyle(.secondary)
                    if model.error != nil { Button("Reconnect", action: model.start) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.selected == nil {
                VStack(spacing: 10) {
                    GenesisWidgetMark()
                    Text("Nothing needs you.").font(.headline)
                    Text("Questions, screenshots, and finished work land here.").font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Choose sessions") { model.showSettings?() }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if section == "Inbox" {
                            inbox
                        } else if section == "Changes" {
                            changes
                        } else {
                            conversation
                        }
                        if section != "Conversation" {
                            ForEach(model.outgoing) { message in outgoing(message) }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 2)
                }.scrollIndicators(.hidden)
                composer
            }
        }
        .padding(18).frame(width: 432).frame(maxHeight: .infinity)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, error in
                    Task { @MainActor in
                        if let url {
                            model.importFile(url)
                        } else if let error {
                            model.error = error.localizedDescription
                        }
                    }
                }
            }
            return !providers.isEmpty
        }
    }

    private var header: some View {
        HStack(spacing: 9) {
            Menu {
                ForEach(model.sessions) { session in
                    Button(session.target.provider.capitalized + " · " + session.title) {
                        model.select(session.key)
                    }
                }
                Divider()
                Button("All sessions and filters…") { model.showSettings?() }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.selected?.title ?? "Agent inbox").font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text(
                        [model.selected?.target.provider.capitalized, model.selected?.project].compactMap { $0 }
                            .joined(separator: " · ")
                    )
                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
            }.menuStyle(.borderlessButton)
            Spacer(minLength: 0)
            Button(action: model.unpinSelected) { Image(systemName: "pin.slash") }
                .help("Unpin this session from the widget").accessibilityLabel("Unpin selected session")
            Button {
                model.openHub?(model.selected)
            } label: {
                Image(systemName: "rectangle.on.rectangle")
            }
            .help("Open this session in Hub").accessibilityLabel("Open session in Hub")
            Button {
                model.showSettings?()
            } label: {
                Image(systemName: "slider.horizontal.3")
            }
            .help("Widget settings and filters").accessibilityLabel("Widget settings")
            Button(action: model.collapse) { Image(systemName: "xmark") }
                .help("Collapse").accessibilityLabel("Collapse widget")
        }.buttonStyle(.plain)
    }

    @ViewBuilder private var inbox: some View {
        if model.cards.count > 1 {
            Picker(
                "Inbox item",
                selection: Binding(
                    get: { model.card?.id ?? "" }, set: { model.selectedCardID = $0 })
            ) {
                ForEach(model.cards.reversed()) { card in
                    Text((card.needsAnswer ? "● " : "") + card.title).lineLimit(1).tag(card.id)
                }
            }.labelsHidden()
        }
        if let card = model.card {
            HStack {
                Label(
                    card.needsAnswer ? "Needs your answer" : card.status.capitalized,
                    systemImage: card.needsAnswer ? "circle.fill" : "checkmark.circle"
                )
                .font(.system(size: 10)).foregroundStyle(card.needsAnswer ? .orange : .secondary)
                Spacer()
                Button(action: model.toggleRead) {
                    Image(systemName: model.reading ? "stop.fill" : "speaker.wave.2")
                }
                .buttonStyle(.plain).help(model.reading ? "Stop reading" : "Read aloud")
                .accessibilityLabel(model.reading ? "Stop reading" : "Read aloud")
            }
            if card.kind != "form" || (card.formItems?.count ?? 0) != 1 {
                Text(card.title).font(.system(size: 16, weight: .semibold)).textSelection(.enabled)
            }
            if !card.body.isEmpty {
                Text(.init(card.body)).font(.system(size: 12)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !card.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(card.attachments) { image in
                            Button {
                                showMedia(.images(card.attachments, image.id))
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    WidgetThumbnail(path: image.path).frame(width: 150, height: 95)
                                    Text(image.label ?? image.name).font(.caption2).lineLimit(1)
                                }
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if card.attachments.count > 1 {
                    Button("Compare screenshots") {
                        showMedia(.images(card.attachments, card.attachments[0].id))
                    }
                }
            }
            if card.needsAnswer {
                if card.kind == "form" {
                    ForEach(card.formItems ?? []) { item in formItem(item, card: card).disabled(model.cardPending) }
                    Button(model.cardPending ? "Answer queued" : "Send answers") { model.submit(answering: true) }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.importing > 0 || model.cardPending)
                } else {
                    ForEach(Array(card.choices.enumerated()), id: \.element.id) { index, choice in
                        Button {
                            model.submit(choice: choice.id)
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Text("\(index + 1)").font(.system(size: 10, design: .monospaced))
                                    .frame(width: 20, height: 20).background(
                                        .white.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
                                Text(choice.title).font(.system(size: 12)).fixedSize(
                                    horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                                if choice.recommended {
                                    Image(systemName: "sparkle").foregroundStyle(.orange).help("Recommended")
                                }
                            }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 9))
                        }.buttonStyle(.plain).disabled(model.importing > 0)
                    }
                }
            }
            if card.kind == "todo" && ["open", "acknowledged"].contains(card.status) {
                HStack {
                    if card.status == "open" {
                        Button("Acknowledge") { model.ledger(card, state: "acknowledged") }
                    }
                    Button("Mark complete") { model.ledger(card, state: "implemented") }
                    Button("Dismiss") { model.ledger(card, state: "dismissed") }
                }.font(.caption)
            } else if card.kind == "decision" && card.needsAnswer {
                HStack {
                    Button("Save draft") { model.ledger(card, state: "drafted") }
                    Button("Dismiss") { model.ledger(card, state: "dismissed") }
                }.font(.caption)
            }
            if card.kind == "result" || card.kind == "answer" {
                HStack {
                    Button("Create handoff") { model.destination("handoff") }
                    Button("New agent with context…") { model.destination("new") }
                }.font(.caption)
            }
            ForEach(Array(card.refs.enumerated()), id: \.offset) { _, ref in
                Button(ref.value) { openReference(ref.value) }.buttonStyle(.link).font(.caption).lineLimit(
                    1)
            }
        } else {
            Text("No inbox items for this session.").foregroundStyle(.secondary).font(.callout)
            Button("See conversation") { section = "Conversation" }
        }
    }

    private func formItem(_ item: WidgetFormItem, card: WidgetCard) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(.init(item.promptMarkdown)).font(.system(size: 12, weight: .medium)).textSelection(
                .enabled)
            ForEach(item.choices ?? []) { choice in
                let selected =
                    model.formAnswers[card.id]?[item.id]?.selectedChoices?.contains(choice.id) == true
                Button {
                    var answer = model.formAnswers[card.id]?[item.id] ?? WidgetFormAnswer(itemId: item.id)
                    var selectedIDs = answer.selectedChoices ?? []
                    if item.allowMultiple == true {
                        if let index = selectedIDs.firstIndex(of: choice.id) {
                            selectedIDs.remove(at: index)
                        } else {
                            selectedIDs.append(choice.id)
                        }
                    } else {
                        selectedIDs = [choice.id]
                    }
                    answer.selectedChoices = selectedIDs
                    model.formAnswers[card.id, default: [:]][item.id] = answer
                } label: {
                    HStack {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        Text(choice.label).font(.system(size: 12))
                        Spacer()
                    }.padding(8).background(
                        .white.opacity(selected ? 0.12 : 0.045), in: RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain)
            }
            if item.allowFreeText != false {
                TextField(
                    "Your answer",
                    text: Binding(
                        get: { model.formAnswers[card.id]?[item.id]?.freeText ?? "" },
                        set: {
                            var answer = model.formAnswers[card.id]?[item.id] ?? WidgetFormAnswer(itemId: item.id)
                            answer.freeText = $0
                            model.formAnswers[card.id, default: [:]][item.id] = answer
                        }), axis: .vertical
                ).textFieldStyle(.roundedBorder).lineLimit(1...4)
            }
            if let answer = card.formAnswers?[item.id], !card.needsAnswer {
                Text(answer.freeText ?? answer.selectedChoices?.joined(separator: ", ") ?? "").font(
                    .caption)
            }
        }
    }

    @ViewBuilder private var conversation: some View {
        if let error = model.transcriptError {
            Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
        }
        ForEach(timeline) { item in
            VStack(alignment: .leading, spacing: 5) {
                Text(item.date, style: .time).font(.system(size: 9, design: .monospaced)).foregroundStyle(
                    .tertiary)
                switch item.event {
                case .turn(let turn):
                    if !turn.text.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(turn.role.capitalized).font(.system(size: 9, weight: .semibold)).foregroundStyle(
                                .secondary)
                            Text(.init(visibleText(turn.text))).font(.system(size: 12)).textSelection(.enabled)
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                turn.role == "user" ? Color.blue.opacity(0.16) : Color.white.opacity(0.04),
                                in: RoundedRectangle(cornerRadius: 11))
                    }
                case .card(let card):
                    VStack(alignment: .leading, spacing: 6) {
                        Text(card.kind.capitalized + " · " + card.status).font(.caption2).foregroundStyle(
                            .secondary)
                        Text(card.title).font(.system(size: 12, weight: .semibold)).textSelection(.enabled)
                        if !card.body.isEmpty {
                            Text(.init(card.body)).font(.system(size: 12)).textSelection(.enabled)
                        }
                        if !card.attachments.isEmpty {
                            HStack {
                                ForEach(card.attachments.prefix(3)) { image in
                                    Button {
                                        showMedia(.images(card.attachments, image.id))
                                    } label: {
                                        WidgetThumbnail(path: image.path).frame(width: 100, height: 65)
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                        if card.needsAnswer {
                            Button("Answer this question") {
                                model.selectedCardID = card.id
                                section = "Inbox"
                            }
                        }
                    }.padding(10).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 11))
                case .outgoing(let message):
                    outgoing(message)
                case .activity(let event):
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(event.title).font(.caption)
                            Text(event.sourceId + " · " + event.body).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        if model.transcript.isEmpty && model.transcriptError == nil {
            Text("Loading recent conversation…").font(.caption).foregroundStyle(.secondary)
        }
    }

    private struct TimelineItem: Identifiable {
        enum Event {
            case turn(TranscriptTurn)
            case card(WidgetCard)
            case outgoing(WidgetOutgoing)
            case activity(WidgetActivityEvent)
        }
        let id: String
        let date: Date
        let event: Event
    }
    private var timeline: [TimelineItem] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        let turns = model.transcript.filter { !$0.text.isEmpty }.map { turn in
            TimelineItem(
                id: "turn:" + turn.id,
                date: turn.at.flatMap { iso.date(from: $0) ?? plain.date(from: $0) } ?? .distantPast,
                event: .turn(turn))
        }
        let cards = model.cards.map {
            TimelineItem(id: $0.id, date: Date(timeIntervalSince1970: $0.at / 1000), event: .card($0))
        }
        let outgoing = model.outgoing.map {
            TimelineItem(
                id: "out:" + $0.id, date: Date(timeIntervalSince1970: $0.createdAt / 1000),
                event: .outgoing($0))
        }
        let activity = (model.snapshot?.activity ?? []).map {
            TimelineItem(id: "event:" + $0.id, date: Date(timeIntervalSince1970: $0.at / 1000), event: .activity($0))
        }
        return (turns + cards + outgoing + activity).sorted {
            $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date
        }
    }

    @ViewBuilder private var changes: some View {
        if let changes = model.snapshot?.changes, changes.available {
            ForEach(changes.files) { file in
                Button {
                    openReference(file.path)
                } label: {
                    HStack {
                        Image(systemName: "doc.text")
                        VStack(alignment: .leading) {
                            Text(URL(fileURLWithPath: file.path).lastPathComponent)
                            Text(file.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text(file.source).font(.caption2).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
            }
        } else {
            Text("No file-change receipts have been recorded for this session.").font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func outgoing(_ message: WidgetOutgoing) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !message.text.isEmpty {
                Text(message.text).font(.system(size: 12)).textSelection(.enabled)
            }
            ForEach(message.assetIds, id: \.self) { id in
                if let asset = model.snapshot?.state.assets[id] { attachment(asset, removable: false) }
            }
            HStack {
                if ["preparing", "dispatching", "queued"].contains(message.state) {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(
                        systemName: message.state == "sent" ? "checkmark.circle.fill" : "exclamationmark.circle"
                    )
                }
                Text(receiptLabel(message)).font(.system(size: 10))
                Spacer(minLength: 0)
            }.foregroundStyle(message.state == "sent" ? .green : .secondary)
            if let error = message.error {
                Text(error).font(.caption2).foregroundStyle(.orange).textSelection(.enabled)
            }
            if ["failed", "waiting-route", "unknown"].contains(message.state) {
                HStack {
                    Button("Retry") {
                        if message.state == "unknown" {
                            retry = message
                        } else {
                            model.action(["action": "retry", "id": .string(message.id)])
                        }
                    }
                    if message.state != "unknown" {
                        Button("Edit") { model.editOutgoing(message) }
                        Button("Cancel") { model.action(["action": "cancel", "id": .string(message.id)]) }
                    }
                    Menu("Choose destination…") {
                        Button("Resume this session in Hub…") { model.destination("resume") }
                        Button("New agent with prepared context…") { model.destination("new") }
                        Button("Create a handoff file") { model.destination("handoff") }
                        Button("Open conversation") { model.openHub?(model.selected) }
                    }
                }.font(.caption2)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.draft.assetIds, id: \.self) { id in
                if let asset = model.snapshot?.state.assets[id] { attachment(asset, removable: true) }
            }
            if model.voiceActive {
                HStack(spacing: 8) {
                    Image(systemName: "waveform").foregroundStyle(.red)
                    Text(
                        model.voiceText.isEmpty ? "Listening… tap Stop to edit the transcript" : model.voiceText
                    )
                    .font(.caption).lineLimit(2)
                    Spacer()
                    ProgressView(value: min(1, model.voiceLevel * 5)).frame(width: 40)
                }
            }
            if model.importing > 0 {
                ProgressView("Saving attachment…").controlSize(.small).font(.caption)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    "Reply to " + (model.selected?.target.provider.capitalized ?? "agent") + "…",
                    text: Binding(get: { model.draft.text }, set: model.setText), axis: .vertical
                )
                .textFieldStyle(.plain).font(.system(size: 12)).lineLimit(1...4).focused($editing)
                .onSubmit {
                    model.submit(
                        answering: model.card?.kind == "decision" && model.card?.needsAnswer == true
                            && !model.cardPending)
                }
                .accessibilityLabel("Reply to selected agent")
                Button {
                    model.submit(
                        answering: model.card?.kind == "decision" && model.card?.needsAnswer == true
                            && !model.cardPending)
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 23)).foregroundStyle(.blue)
                }.buttonStyle(.plain).disabled(model.importing > 0).accessibilityLabel("Send reply")
            }
            HStack(spacing: 15) {
                Button(action: model.chooseFiles) { Image(systemName: "paperclip") }.help(
                    "Attach images or videos"
                ).accessibilityLabel("Attach media")
                Button {
                    _ = model.pasteMedia()
                } label: {
                    Image(systemName: "clipboard")
                }.help("Paste image or video").accessibilityLabel("Paste media")
                Button(action: model.capture) { Image(systemName: "camera") }.help("Capture a screenshot")
                    .accessibilityLabel("Capture screenshot")
                Button(action: model.toggleVoice) {
                    Image(systemName: model.voiceActive ? "stop.circle.fill" : "mic").padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
                .modifier(WidgetGlassControl())
                .foregroundStyle(model.voiceActive ? .red : .secondary)
                .help(model.voiceActive ? "Stop dictation" : "Dictate").accessibilityLabel(
                    model.voiceActive ? "Stop dictation" : "Dictate")
                Spacer()
                Text("⌘V media · Esc close").font(.system(size: 9)).foregroundStyle(.tertiary)
            }.font(.system(size: 12)).foregroundStyle(.secondary).buttonStyle(.plain)
        }
        .padding(11).background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 13))
    }

    private func attachment(_ asset: WidgetAsset, removable: Bool) -> some View {
        HStack(spacing: 8) {
            Button {
                if asset.type == "video" {
                    showMedia(.video(asset.id))
                } else {
                    showMedia(.asset(asset.id))
                }
            } label: {
                HStack {
                    if asset.type == "image" {
                        WidgetThumbnail(path: asset.path).frame(width: 42, height: 30)
                    } else {
                        Image(systemName: "film").frame(width: 30)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(asset.name).font(.caption).lineLimit(1)
                        if asset.type == "video" {
                            Text(asset.status == "ready" ? videoSummary(asset) : (asset.status ?? "Preparing"))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if ["pending", "preparing"].contains(asset.status ?? "") {
                        ProgressView().controlSize(.mini)
                    }
                }
            }.buttonStyle(.plain)
            Spacer(minLength: 0)
            if removable {
                Button {
                    model.action([
                        "action": "remove-asset", "key": .string(model.selectedKey), "id": .string(asset.id),
                    ])
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain).accessibilityLabel("Remove " + asset.name)
            }
        }
    }

    private func videoSummary(_ asset: WidgetAsset) -> String {
        guard let counts = model.snapshot?.manifests[asset.id]?.counts else { return "Ready" }
        let review =
            (asset.settings?.minimumDifferencePct ?? 0) > 0 && asset.confirmedRevision != asset.revision
        return "\(counts.kept) frames · \(counts.images) images" + (review ? " · Review required" : "")
    }
    private func receiptLabel(_ message: WidgetOutgoing) -> String {
        switch message.state {
        case "sent": return "Sent · " + (message.receipt?.detail ?? message.target.provider)
        case "review": return "Review the skipped video frames before sending"
        case "preparing": return "Preparing video · message saved"
        case "queued": return "Queued"
        case "dispatching": return "Sending…"
        case "waiting-route": return "Waiting for an available session route"
        case "unknown": return "Delivery unknown · check the conversation"
        default: return message.state.capitalized
        }
    }
    private func showMedia(_ selection: WidgetMediaSelection) {
        model.dialogOpen = true
        media = selection
    }
    private func openReference(_ value: String) {
        if let url = URL(string: value), ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        } else if value.hasPrefix("/") {
            NSWorkspace.shared.open(URL(fileURLWithPath: value))
        }
    }
    private func visibleText(_ text: String) -> String {
        text.replacingOccurrences(
            of: "<from(?:Image|Video)>[\\s\\S]*?</from(?:Image|Video)>", with: "",
            options: .regularExpression)
    }
}
