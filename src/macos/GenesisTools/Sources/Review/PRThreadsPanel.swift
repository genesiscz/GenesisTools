import AppKit
import SwiftUI

/// The PR bar above the diff: the live thread counts, Submit review, and a threads list folded
/// away by default. The main path is the diff itself: each thread card there has Reply, Resolve and
/// Edit / Delete on my drafts (web/diff-viewer/main.ts). The list also holds the outdated threads,
/// which have no line in the diff.
struct PRReviewBar: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject var store: PRThreadsStore
    /// The room the diff column has for the list; the diff under it keeps at least a few lines.
    var maxListHeight: CGFloat = 900
    @AppStorage("review.prThreads.open", store: HubDefaults.store) private var open = false
    @AppStorage("review.prThreads.height", store: HubDefaults.store) private var listHeight = 260.0
    @State private var submitting = false
    @State private var fixing = false
    /// The height the drag began with: the layout keeps it until release (see `threadsList`).
    @State private var dragStart: Double?
    @State private var liveHeight: Double?
    @State private var hovering = false
    @GestureState private var dragging = false

    static let minListHeight: CGFloat = 110

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .foregroundColor(ReviewPalette.renamed)
                if let pr = store.pr {
                    ExternalLink(text: pr.identity.label, url: URL(string: pr.webUrl ?? pr.url), font: .system(size: 12, weight: .semibold),
                                 color: Color(red: 0.62, green: 0.78, blue: 1), glyph: .onHover, tooltip: pr.title)
                        .fixedSize()
                    // Inside the hub the PR header above already links the author and both branches.
                    if !model.embedded {
                        PRBarLinks(pr: pr)
                    }
                } else {
                    Text(verbatim: model.prLabel).font(.system(size: 12, weight: .semibold)).fixedSize()
                }
                summary
                    .layoutPriority(1)
                if store.loading || store.busy != nil {
                    ProgressView().controlSize(.small)
                }
                if let busy = store.busy {
                    Text(busy).foregroundColor(ReviewPalette.dim).fixedSize()
                }
                Spacer(minLength: 8)
                if let notice = store.notice {
                    NoticePill(text: notice, isError: notice.hasPrefix("Failed")) { store.notice = nil }
                        .layoutPriority(-1)
                }
                IconButton(systemName: open ? "rectangle.topthird.inset.filled" : "list.bullet.rectangle",
                           tooltip: open ? "Hide the PR threads list" : "Show the PR threads list: reply, resolve, edit your drafts") {
                    open.toggle()
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Load the PR threads again from the host") {
                    store.load(noCache: true)
                }
                if !model.selectedThreads.isEmpty {
                    Button {
                        fixing = true
                    } label: {
                        Label("Fix \(model.selectedThreads.count) \(model.selectedThreads.count == 1 ? "thread" : "threads")…", systemImage: "wrench.and.screwdriver")
                            .labelStyle(.titleOnly)
                            .fixedSize()
                    }
                    .disabled(store.payload == nil)
                    .instantTooltip("Send the selected threads as one task to the agent that owns the branch, then focus its cmux pane (f)")
                    .popover(isPresented: $fixing, arrowEdge: .bottom) {
                        FixThreadsForm(model: model, store: store) { fixing = false }
                    }
                    IconButton(systemName: "xmark.circle", tooltip: "Clear the Fix selection") {
                        model.clearThreadSelection()
                    }
                }
                Button {
                    submitting = true
                } label: {
                    Label("Submit review…", systemImage: "paperplane.circle")
                        .labelStyle(.titleOnly)
                        .fixedSize()
                }
                .disabled(store.payload == nil || store.busy != nil)
                .instantTooltip("Publish your pending drafts as one review (Comment, Approve or Request changes); asks first")
                .popover(isPresented: $submitting, arrowEdge: .bottom) {
                    SubmitReviewForm(store: store) { submitting = false }
                }
            }
            .font(.system(size: 12))
            .buttonStyle(.genHoverPlain())
            .padding(.horizontal, 14)
            .frame(height: 34)
            if model.showsFixFormInline {
                // A `--snapshot --fix-form` run: a popover is its own window and never reaches the PNG.
                FixThreadsForm(model: model, store: store) { model.showsFixFormInline = false }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if open {
                threadsList
            }
        }
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
        // s and f from the diff: the same forms the buttons open, each still asking before it sends.
        .onChange(of: model.submitRequests) { _, _ in
            if store.payload != nil, store.busy == nil { submitting = true }
        }
        .onChange(of: model.fixRequests) { _, _ in
            // The Fix button waits for the threads too; before they load there is nothing to fix.
            if store.payload != nil, !model.selectedThreads.isEmpty { fixing = true }
        }
    }

    private func clamped(_ height: Double) -> CGFloat {
        min(max(Self.minListHeight, CGFloat(height)), max(Self.minListHeight, maxListHeight))
    }

    /// The list with a resizer on its bottom edge. While a drag runs, the layout keeps the height the
    /// drag began with and the list draws over the diff below (or leaves a band of the pane showing);
    /// the height is saved and the web diff reflows once, on release. Resizing the web view per drag
    /// step would lay out the diff for every step, as a side panel drag did before `HubLiveResize`.
    private var threadsList: some View {
        let slot = clamped(dragStart ?? listHeight)
        let shown = clamped(liveHeight ?? listHeight)
        return PRThreadsList(model: model, store: store)
            .frame(height: shown)
            .hubSurface(.content)
            .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .top)
            .overlay(alignment: .bottom) { resizer }
            .frame(height: slot, alignment: .top)
    }

    private var resizer: some View {
        let hot = hovering || dragStart != nil
        return ZStack {
            Rectangle()
                .fill(hot ? ReviewPalette.renamed.opacity(0.55) : Color.clear)
                .frame(height: 1)
            Capsule()
                .fill(ReviewPalette.renamed)
                .frame(width: 36, height: 4)
                .shadow(color: ReviewPalette.renamed.opacity(0.6), radius: 6)
                .opacity(hot ? 1 : 0)
                .scaleEffect(x: hot ? 1 : 0.4)
        }
        // A 10 pt target around a 1 pt line: the edge does not have to be hit to the pixel.
        .frame(height: 1)
        .frame(maxWidth: .infinity)
        .overlay(Color.clear.frame(height: 10).contentShape(Rectangle()))
        .animation(.easeOut(duration: 0.14), value: hot)
        .onHover { inside in
            guard inside != hovering else { return }
            hovering = inside
            if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
        }
        .onDisappear {
            if hovering { NSCursor.pop() }
            hovering = false
        }
        // Global space: the handle moves with the list during the drag, so local translations would drift.
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .updating($dragging) { _, state, _ in state = true }
                .onChanged { value in dragChanged(value.translation.height) }
                .onEnded { _ in dragEnded() }
        )
        // A cancelled gesture never calls onEnded: without this the diff stayed frozen.
        .onChange(of: dragging) { _, active in
            if !active, dragStart != nil { dragEnded() }
        }
        .instantTooltip("Drag to resize the threads list")
        .accessibilityElement()
        .accessibilityLabel(Text("Resize the PR threads list"))
        .accessibilityValue(Text(verbatim: "\(Int(clamped(listHeight))) points"))
        .accessibilityAdjustableAction { direction in
            listHeight = Double(clamped(listHeight + (direction == .increment ? 40 : -40)))
        }
    }

    private func dragChanged(_ translation: CGFloat) {
        if dragStart == nil {
            dragStart = Double(clamped(listHeight))
            HubLiveResize.shared.begin("prThreads")
        }
        liveHeight = Double(clamped((dragStart ?? listHeight) + Double(translation)))
    }

    private func dragEnded() {
        // Both onEnded and the gesture-state reset call this; only the first one counts.
        guard dragStart != nil else { return }
        let final = liveHeight ?? listHeight
        HubPerf.log("review.prThreads list resized to \(Int(final))")
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            listHeight = final
            liveHeight = nil
            dragStart = nil
        }
        HubLiveResize.shared.end("prThreads")
    }

    @ViewBuilder
    private var summary: some View {
        if let payload = store.payload {
            let openCount = payload.threads.filter { !$0.resolved }.count
            let variants = Self.summaryVariants(threads: payload.threads.count, open: openCount, drafts: payload.draftCount)
            ViewThatFits(in: .horizontal) {
                ForEach(variants.indices, id: \.self) { index in
                    // The shortest one never truncates: a cut word ("0d") read as a code.
                    if index == variants.count - 1 {
                        Text(verbatim: variants[index]).fixedSize()
                    } else {
                        Text(verbatim: variants[index])
                    }
                }
            }
                .foregroundColor(openCount > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                .lineLimit(1)
                .instantTooltip(model.showsLiveThreadsInline
                    ? "Threads on the PR; the ones that are not outdated also sit on their lines in the diff"
                    : "Threads on the PR; they sit on their lines only in the Branch scope or the PR's range")
        } else if let error = store.error {
            Text(verbatim: "Threads did not load: \(error)")
                .foregroundColor(ReviewPalette.removed)
                .lineLimit(1)
                .truncationMode(.tail)
                .instantTooltip(error)
        } else {
            Text("Loading threads…").foregroundColor(ReviewPalette.dim)
        }
    }

    /// The bar's count, widest first. A narrow diff pane drops whole words before numbers, zero
    /// drafts go first of all, and a pending draft count stays to the last variant (Submit review
    /// sends them).
    static func summaryVariants(threads: Int, open: Int, drafts: Int) -> [String] {
        let draftText = drafts == 1 ? "1 draft" : "\(drafts) drafts"
        if drafts == 0 {
            return ["\(threads) threads · \(open) open", "\(open)/\(threads) open", "\(open) open"]
        }
        return ["\(threads) threads · \(open) open · \(draftText)", "\(open)/\(threads) open · \(draftText)", "\(open) open · \(draftText)", draftText]
    }
}

/// The PR's author and its branches as host links (ForgeWeb), dim until hovered: "genesiscz ·
/// feat/x → master". The head branch shortens first; the target and the author keep their width.
private struct PRBarLinks: View {
    let pr: PRInfo

    var body: some View {
        let forge = pr.forge
        let font = Font.system(size: 11.5)
        if let author = pr.author, !author.isEmpty {
            ExternalLink(text: author, url: forge?.user(author), font: font, icon: "person.crop.circle", glyph: .onHover,
                         tooltip: "\(author) opened \(pr.identity.label)")
                .fixedSize()
        }
        if let source = pr.sourceBranch, let target = pr.targetBranch {
            ExternalLink(text: source, url: pr.sourceBranchURL, font: .system(size: 11.5, design: .monospaced), glyph: .onHover,
                         tooltip: "The PR's branch")
                .frame(minWidth: 40)
            ExternalLink(text: "→ \(target)", url: pr.compareURL,
                         font: .system(size: 11.5, design: .monospaced), glyph: .onHover, tooltip: "Compare \(target)...\(source)")
                .fixedSize()
        }
    }
}

/// Every thread of the PR, open ones first; a row's path opens that file in the diff.
private struct PRThreadsList: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject var store: PRThreadsStore
    @AppStorage("review.prThreads.thisFile", store: HubDefaults.store) private var onlyThisFile = false
    @AppStorage("review.prThreads.closed", store: HubDefaults.store) private var showClosed = false
    @State private var find = PanelFindModel(scope: "pr.threads", title: "the threads")

    private var visible: [PRThread] {
        let selectedPath = model.repoPath(of: model.selectedID)
        return (store.payload?.threads ?? [])
            .filter { showClosed || (!$0.resolved && !$0.outdated) || $0.comments.contains(where: \.isDraft) }
            .filter { !onlyThisFile || $0.path == selectedPath }
            .sorted { ($0.resolved ? 1 : 0, $0.path, $0.line) < ($1.resolved ? 1 : 0, $1.path, $1.line) }
    }

    var body: some View {
        let threads = visible
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Toggle("Only the selected file", isOn: $onlyThisFile)
                    .toggleStyle(.checkbox)
                    .instantTooltip("Show only the threads on the file open in the diff")
                Toggle("Resolved and outdated", isOn: $showClosed)
                    .toggleStyle(.checkbox)
                    .instantTooltip("Also show threads that are resolved, or whose lines changed since")
                Spacer()
                let fixable = threads.filter { !$0.resolved && !$0.isMyDraft }.map(\.id)
                if !fixable.isEmpty {
                    Button("Select open for Fix") {
                        model.selectedThreads.formUnion(fixable)
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("Pick every open thread shown here for Fix threads")
                }
                Text(verbatim: "\(threads.count) shown")
                    .foregroundColor(ReviewPalette.dim)
            }
            .font(.system(size: 11.5))
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            PanelFindBar(find: find)
            if threads.isEmpty {
                Text(store.payload == nil ? "No threads loaded yet." : "No thread matches these filters.")
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(threads) { thread in
                            PRThreadRow(model: model, store: store, thread: thread, selected: model.selectedThreads.contains(thread.id))
                                .findRow(thread.id, cornerRadius: 8)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
                }
            }
        }
        .panelFind(find, revision: threads.map(\.id) + threads.flatMap { $0.comments.map(\.bodyMarkdown) }) {
            threads.map { thread in
                PanelFindRow(id: thread.id, fields: [PanelFindField("path", "\(thread.path):\(thread.line)")]
                    + thread.comments.flatMap { comment in
                        [PanelFindField("author:\(comment.id)", comment.author.name),
                         PanelFindField("comment:\(comment.id)", comment.bodyMarkdown, markdown: true)]
                    })
            }
        }
    }
}

private struct PRThreadRow: View {
    let model: ReviewModel
    @ObservedObject var store: PRThreadsStore
    let thread: PRThread
    /// In the Fix selection (the same set as the diff cards' Fix checkboxes).
    let selected: Bool
    @State private var replying = false
    @State private var replyText = ""
    @State private var editingID: String?
    @State private var editText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if !thread.isMyDraft {
                    Toggle("", isOn: Binding(get: { selected }, set: { _ in model.toggleThreadSelection(thread.id) }))
                        .toggleStyle(.checkbox)
                        .labelsHidden()
                        .instantTooltip("Select this thread for Fix threads: the selected threads go as one task to the agent that owns the branch")
                }
                Button {
                    model.reveal(path: thread.path)
                } label: {
                    FindText("\(thread.path):\(thread.line)", field: "path")
                        .font(.system(size: 11.5, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Open \(thread.path) in the diff")
                if thread.isMyDraft {
                    PRBadge(text: "Your draft", color: ReviewPalette.modified)
                } else {
                    PRBadge(text: thread.resolved ? "Resolved" : "Open", color: thread.resolved ? ReviewPalette.added : ReviewPalette.modified)
                }
                if thread.outdated {
                    PRBadge(text: "Outdated", color: ReviewPalette.dim)
                }
                Spacer(minLength: 6)
                if !thread.isMyDraft {
                    if thread.resolvable {
                        Button(thread.resolved ? "Unresolve" : "Resolve") {
                            store.resolve(thread: thread.id, resolved: !thread.resolved)
                        }
                        .instantTooltip(thread.resolved ? "Reopen this thread on the PR" : "Mark this thread resolved on the PR")
                    }
                    Button("Reply") {
                        replying = true
                    }
                    .disabled(replying)
                    .instantTooltip("Write a reply: save it as a draft in your pending review, or post it now")
                }
            }
            ForEach(thread.comments) { comment in
                commentView(comment)
            }
            if replying {
                replyComposer
            }
        }
        .font(.system(size: 12))
        .buttonStyle(.genHoverPlain())
        .disabled(store.busy != nil)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(ReviewPalette.hairline))
        .opacity(thread.resolved || thread.outdated ? 0.72 : 1)
    }

    @ViewBuilder
    private func commentView(_ comment: PRThreadComment) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                ExternalLink(text: comment.author.name, url: store.pr?.forge?.user(comment.author.username),
                             font: .system(size: 12, weight: .semibold), color: Color.white.opacity(0.92), glyph: .onHover,
                             tooltip: "@\(comment.author.username) on the host", findField: "author:\(comment.id)")
                if comment.author.name != comment.author.username {
                    Text(verbatim: "@\(comment.author.username)").foregroundColor(ReviewPalette.dim)
                }
                Text(verbatim: PRThreadRendering.ago(comment.createdAt))
                    .foregroundColor(ReviewPalette.dim)
                    .instantTooltip(comment.createdAt)
                if comment.editedAt != nil {
                    Text("edited").foregroundColor(ReviewPalette.dim)
                }
                if comment.isDraft {
                    PRBadge(text: "Draft", color: ReviewPalette.modified)
                        .instantTooltip("Only you see it until you submit the review")
                }
                Spacer(minLength: 6)
                if comment.isDraft, editingID != comment.id {
                    Button("Edit") {
                        editText = comment.bodyMarkdown
                        editingID = comment.id
                    }
                    .instantTooltip("Change the text of this draft")
                    Button("Delete") {
                        if confirmDelete() {
                            store.deleteDraft(thread: thread.id, note: comment.id)
                        }
                    }
                    .instantTooltip("Delete this draft from your pending review (asks first)")
                }
            }
            .font(.system(size: 11.5))
            if editingID == comment.id {
                editor(text: $editText)
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel") { editingID = nil }
                    Button("Save draft") {
                        // The editor stays open with its text until the host took the write, as the diff
                        // cards do: a failed or refused write must not lose what was typed.
                        store.updateDraft(thread: thread.id, note: comment.id, body: editText) { ok in
                            if ok {
                                editingID = nil
                            }
                        }
                    }
                    .disabled(editText.trimmed.isEmpty)
                    .instantTooltip("Replace the draft's text; it stays a draft")
                }
            } else {
                MarkdownContentView(markdown: comment.bodyMarkdown)
                    .findField("comment:\(comment.id)")
                    .font(.system(size: 12))
                    .textSelection(.enabled)
            }
        }
        .padding(.leading, comment.id == thread.comments.first?.id ? 0 : 12)
    }

    private var replyComposer: some View {
        VStack(alignment: .leading, spacing: 6) {
            editor(text: $replyText)
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") {
                    replying = false
                }
                Button("Post now…") {
                    if confirmPost() {
                        store.reply(thread: thread.id, body: replyText, draft: false) { ok in
                            closeComposer(ok)
                        }
                    }
                }
                .disabled(replyText.trimmed.isEmpty)
                .instantTooltip("Publish the reply at once, visible to everyone (asks first)")
                Button("Save as draft") {
                    store.reply(thread: thread.id, body: replyText, draft: true) { ok in
                        closeComposer(ok)
                    }
                }
                .disabled(replyText.trimmed.isEmpty)
                .instantTooltip("Add the reply to your pending review; Submit review publishes it")
            }
        }
    }

    /// Clears the reply only once the host took it; a failed or refused write keeps the text.
    private func closeComposer(_ ok: Bool) {
        guard ok else { return }
        replying = false
        replyText = ""
    }

    private func editor(text: Binding<String>) -> some View {
        TextEditor(text: text)
            .font(.system(size: 12.5))
            .scrollContentBackground(.hidden)
            .frame(height: 72)
            .padding(4)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.15)))
    }

    private func confirmPost() -> Bool {
        PRConfirm.post(replyText, on: store, where_: "A reply in the thread on \(thread.path):\(thread.line).")
    }

    private func confirmDelete() -> Bool {
        PRConfirm.deleteDraft(on: store)
    }
}

/// The questions asked before a write that others see (a post) or that cannot be undone (a delete).
/// The same alerts for the threads list and the diff's thread cards.
enum PRConfirm {
    static func post(_ text: String, on store: PRThreadsStore, where_: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Post on \(store.label) now?"
        alert.informativeText = "Everyone on the \(store.pr?.identity.isGitLab == true ? "merge request" : "pull request") sees it at once. \(where_)\n\n\(text.prefix(400))"
        alert.addButton(withTitle: "Post")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    static func deleteDraft(on store: PRThreadsStore) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Delete this draft?"
        alert.informativeText = "It leaves your pending review on \(store.label). Nobody else saw it."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

private struct PRBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(color.opacity(0.6)))
            .fixedSize()
    }
}

/// Comment / Approve / Request changes with an optional summary. Submitting asks again in an
/// NSAlert that names the PR and the number of drafts: it is the one path to `pr publish`.
private struct SubmitReviewForm: View {
    @ObservedObject var store: PRThreadsStore
    let close: () -> Void
    @State private var event = PRReviewEvent.comment
    @State private var summary = ""

    private var events: [PRReviewEvent] {
        // GitLab has no "request changes" review.
        store.pr?.identity.isGitLab == true ? [.comment, .approve] : PRReviewEvent.allCases
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Submit your review on \(store.label)")
                .font(.system(size: 13, weight: .semibold))
            Text("\(store.payload?.draftCount ?? 0) pending drafts go out with it. Everyone sees the review at once.")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            Picker("", selection: $event) {
                ForEach(events) { event in
                    Text(event.title).tag(event)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .instantTooltip("The kind of review")
            Text("Summary (optional)")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
            TextEditor(text: $summary)
                .font(.system(size: 12.5))
                .scrollContentBackground(.hidden)
                .frame(height: 90)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.15)))
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel", action: close)
                    .keyboardShortcut(.cancelAction)
                Button("Submit…") {
                    let event = event
                    let summary = summary
                    close()
                    // After the popover is gone: a modal alert over a transient popover can close it mid-click.
                    DispatchQueue.main.async {
                        if confirm(event: event, summary: summary) {
                            store.submitReview(event: event, summary: summary)
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .instantTooltip("Asks once more, naming the PR and the number of drafts")
            }
            .buttonStyle(.genHoverPlain())
        }
        .padding(14)
        .frame(width: 400)
    }

    private func confirm(event: PRReviewEvent, summary: String) -> Bool {
        let drafts = store.payload?.draftCount ?? 0
        let alert = NSAlert()
        alert.messageText = "Submit your review on \(store.label)?"
        var text = "\(store.pr?.title ?? "")\n\n\(event.title). \(drafts) pending \(drafts == 1 ? "draft goes" : "drafts go") out with it, and everyone on the \(store.pr?.identity.isGitLab == true ? "merge request" : "pull request") sees the review at once."
        if !summary.trimmed.isEmpty {
            text += "\n\nSummary: \(summary.trimmed.prefix(300))"
        }
        alert.informativeText = text
        alert.addButton(withTitle: "Submit review")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}
