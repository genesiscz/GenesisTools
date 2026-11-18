import SwiftUI

extension MeetingsAPI {
    enum ThresholdPreview: MeetingsServiceMethod {
        static let name = "meeting.thresholds.preview"
        struct Params: Codable, Equatable { var meeting: String?; var values: [String: Double] }
        struct Row: Decodable, Equatable, Identifiable {
            let name, path, title, meaning, source: String
            let min, step, defaultValue, globalValue, value: Double
            let max: Double?
            var id: String { name }
            var detail: String {
                var text = "\(meaning) Default \(defaultValue.formatted())."
                if source.contains("dictionary") {
                    text += " This meeting uses \(value.formatted()) from \(source)."
                }
                return text
            }
        }
        struct Item: Decodable, Equatable {
            let status, description: String
            let confidence: Double?
            var summary: String {
                "\(description) · \(status)" + (confidence.map { " · \($0.formatted(.percent))" } ?? "")
            }
        }
        struct Change: Decodable, Equatable, Identifiable {
            let key, kind, change, text, reason: String
            let atSec: Double?
            let before, after: Item?
            var id: String { key }
        }
        struct Count: Decodable, Equatable, Identifiable {
            let kind: String
            let added, removed, changed: Int
            var id: String { kind }
            var summary: String {
                var parts: [String] = []
                if added > 0 { parts.append("+\(Plural.count(added, kind))") }
                if removed > 0 { parts.append("−\(Plural.count(removed, kind))") }
                if changed > 0 { parts.append("\(Plural.count(changed, kind)) changed") }
                return parts.joined(separator: ", ")
            }
        }
        struct Result: Decodable, Equatable {
            let thresholds: [Row]
            let counts: [Count]
            let changes: [Change]
            let warnings: [String]
        }
    }
}

/// Only explicit edits are saved. An effective dictionary override is never copied into a global preference.
struct ThresholdDraft: Equatable {
    private(set) var values: [String: Double] = [:]
    private(set) var active: String?
    mutating func set(_ value: Double, for row: MeetingsAPI.ThresholdPreview.Row) {
        active = row.name
        if value == row.globalValue { values.removeValue(forKey: row.name) }
        else { values[row.name] = value }
    }

    func edits(_ rows: [MeetingsAPI.ThresholdPreview.Row]) -> [MeetingsAPI.ConfigEdit.Edit] {
        rows.compactMap { row in
            values[row.name].map { .init(path: row.path, value: .number($0), expect: .number(row.globalValue)) }
        }
    }
}

struct MeetingsThresholdsPage: View {
    @Bindable var model: MeetingsSettingsModel
    @Environment(\.nativeSettingsIndexing) private var indexing
    @State private var meetingListError: String?
    @State private var draft = ThresholdDraft()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            NativeSettingsPicker("Preview on meeting", identifier: "meetings.thresholds.meeting",
                                 options: model.dictionaryPreviewMeetings.options,
                                 selection: $model.dictionaryPreviewMeetings.selection)
            if let meetingListError {
                Text(meetingListError).font(.callout).foregroundStyle(.secondary)
            }
            ThresholdEditor(model: model, meeting: model.dictionaryPreviewMeetings.selection, draft: $draft)
                .id(model.dictionaryPreviewMeetings.selection)
        }
        .modifier(PageNotices(model: model.notices, shown: !indexing))
        .task {
            guard !indexing else { return }
            do {
                let overview = try await MeetingsWindowModel.overviewRead(days: MeetingsPreferences.days(.standard)).run(service: model.service)
                try Task.checkCancellation()
                model.dictionaryPreviewMeetings.receive(overview.meetings)
            } catch {
                if !Task.isCancelled { meetingListError = asFailure(error).sentence }
            }
        }
    }
}

private struct ThresholdEditor: View {
    typealias API = MeetingsAPI.ThresholdPreview
    let model: MeetingsSettingsModel
    let meeting: String
    @Environment(\.nativeSettingsIndexing) private var indexing
    @Binding var draft: ThresholdDraft
    @State private var result: API.Result?
    @State private var accepted: [String: Double]?
    @State private var failure: String?
    @State private var saving = false
    @State private var reload = 0

    private struct Request: Equatable {
        let values: [String: Double]
        let reload: Int
    }
    private var request: Request { Request(values: draft.values, reload: reload) }
    private var previewed: Bool { accepted == draft.values }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let result {
                HStack {
                    Text("Changes apply to all meetings.").foregroundStyle(.secondary)
                    Spacer()
                    Button("Discard") { draft = ThresholdDraft() }
                        .disabled(draft.values.isEmpty || saving)
                    Button(saving ? "Saving…" : "Save globally") {
                        Task { await save(result.thresholds) }
                    }
                    .disabled(!model.writes || draft.values.isEmpty || saving || (!meeting.isEmpty && !previewed))
                    .accessibilityIdentifier("meetings.thresholds.save")
                }
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(result.thresholds) { row in
                        Divider()
                        control(row)
                        if row.name == draft.active && !meeting.isEmpty && !draft.values.isEmpty {
                            if previewed { differences(result) }
                            else if failure == nil { ProgressView("Comparing this meeting…").controlSize(.small) }
                        }
                    }
                }
                .disabled(saving)
            } else if failure == nil {
                ProgressView("Reading thresholds…").controlSize(.small)
            }
            if let failure {
                HStack {
                    Text(failure).foregroundStyle(.red).textSelection(.enabled)
                    Button("Reload") { reload += 1 }
                }
            }
        }
        .task(id: request) { await compare(request) }
    }

    private func control(_ row: API.Row) -> some View {
        let value = Binding(get: { draft.values[row.name] ?? row.globalValue }, set: { newValue in
            draft.set(newValue, for: row)
            failure = nil
        })
        return Group {
            if let maximum = row.max {
                NativeSettingsSlider(row.title, detail: row.detail, identifier: "meetings.thresholds.\(row.name)",
                                     value: value, in: row.min...maximum, step: row.step, format: { $0.formatted() })
            } else {
                HStack {
                    VStack(alignment: .leading) {
                        Text(row.title)
                        Text(row.detail).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    TextField(row.title, value: Binding(get: { value.wrappedValue }, set: { number in
                        guard number.isFinite, number >= row.min, row.step != 1 || number.rounded() == number else { return }
                        value.wrappedValue = number
                    }), format: .number)
                    .labelsHidden().frame(width: 72).monospacedDigit()
                    .accessibilityIdentifier("meetings.thresholds.\(row.name)")
                }
            }
        }
    }

    @ViewBuilder private func differences(_ result: API.Result) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(result.counts) { count in Text(count.summary).font(.headline) }
            if result.changes.isEmpty { Text("No changes in this meeting.").foregroundStyle(.secondary) }
            ForEach(result.warnings, id: \.self) { warning in Text(warning).font(.caption) }
        }
        if !result.changes.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(result.changes) { change in
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(change.atSec.map(MeetingsFormat.clock) ?? "Untimed") · \(change.kind) · \(change.change)")
                                .font(.caption.weight(.semibold)).monospacedDigit()
                            Text(change.text).textSelection(.enabled)
                            if let before = change.before { Text("Before · \(before.summary)").foregroundStyle(.secondary) }
                            if let after = change.after { Text("After · \(after.summary)") }
                            Text(change.reason).font(.caption).foregroundStyle(.secondary)
                        }
                        Divider()
                    }
                }
            }
            .frame(height: 220)
            .accessibilityIdentifier("meetings.thresholds.differences")
        }
    }

    private func compare(_ asked: Request) async {
        guard !indexing else { return }
        let previewValues = meeting.isEmpty ? [:] : asked.values
        if meeting.isEmpty, result != nil, !asked.values.isEmpty, failure == nil { return }
        do {
            if !previewValues.isEmpty { try await Task.sleep(for: .milliseconds(350)) }
            var args = ["thresholds"] + (meeting.isEmpty ? [] : [meeting]) + ["--json"]
            if !previewValues.isEmpty {
                args += ["--preview", "--set"] + previewValues.keys.sorted().map { "\($0)=\(previewValues[$0]!)" }
            }
            let current = try await model.readLibrary(API.self, .init(meeting: meeting.isEmpty ? nil : meeting, values: previewValues),
                                                      orRun: args)
            try Task.checkCancellation()
            guard request == asked else { return }
            result = current
            model.thresholdsReady = true
            accepted = asked.values
            failure = nil
        } catch {
            if !Task.isCancelled && request == asked {
                failure = asFailure(error).sentence
                model.thresholdsReady = true
                accepted = nil
            }
        }
    }

    private func save(_ rows: [API.Row]) async {
        let edits = draft.edits(rows)
        guard model.writes, !saving, !edits.isEmpty, meeting.isEmpty || previewed else { return }
        saving = true
        defer { saving = false }
        do {
            let data = try JSONEncoder().encode(edits)
            _ = try await model.writeLibrary(MeetingsAPI.ConfigEdit.self, .init(edits: edits),
                                             orRun: ["config", "edit", String(decoding: data, as: UTF8.self)])
            model.loadSettings()
            draft = ThresholdDraft()
            reload += 1
            model.notices.push(StackedNotice(text: "Saved global meeting thresholds"))
        } catch {
            failure = asFailure(error).sentence
        }
    }
}
