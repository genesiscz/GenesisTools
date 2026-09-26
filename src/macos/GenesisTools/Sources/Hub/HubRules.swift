import SwiftUI

// Notification rules: "session idle longer than X", "a new decision posted", "CI failed on a watched
// PR", "a session's context over Y %". The list and every change go through `tools hub rules`
// (src/hub/lib/rules.ts; the rules live in the hub config, key notificationRules). The rules are
// evaluated by the `hub-pr-notify` daemon tick (no timer in the hub), so they notify while the hub is
// closed too. "Test" runs `tools hub rules test`: what would notify now, nothing posted or saved.

struct HubRule: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let kind: String
    let enabled: Bool
    let label: String?
    let minutes: Double?
    let percent: Double?
    let project: String?
    let match: String?
}

struct HubRulesList: Decodable, Equatable, Sendable {
    let rules: [HubRule]
    let labels: [String: String]
}

struct HubRuleReport: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let enabled: Bool
    let problem: String?
    let matches: Int
    let fired: Int
    let seeded: Bool
    let note: String?
}

struct HubRuleFiring: Decodable, Equatable, Hashable, Sendable {
    let ruleId: String
    let title: String
    let subtitle: String
    let message: String
}

/// `tools hub config get --json`: hub-wide settings (src/hub/commands/config.ts).
struct HubConfigValues: Decodable, Equatable, Sendable {
    let prLookupCacheSeconds: Int
}

struct HubRulesRun: Decodable, Equatable, Sendable {
    let skipped: String?
    let reports: [HubRuleReport]
    let firings: [HubRuleFiring]
}

/// The rule kinds the panel offers and the argv of `tools hub rules add` for a filled form.
enum HubRuleKind: String, CaseIterable, Sendable {
    case idle, decision, ciFailed, context

    var title: String {
        switch self {
        case .idle: return "Session idle"
        case .decision: return "New decision"
        case .ciFailed: return "CI failed"
        case .context: return "Context full"
        }
    }

    var threshold: (label: String, flag: String, placeholder: String)? {
        switch self {
        case .idle: return ("minutes", "--minutes", "30")
        case .context: return ("percent", "--percent", "80")
        case .decision, .ciFailed: return nil
        }
    }

    /// `--project` scopes sessions; a PR rule filters by `owner/repo#number` with `--match`.
    var scopeFlag: String { self == .ciFailed ? "--match" : "--project" }
    var scopePlaceholder: String { self == .ciFailed ? "PR filter (repo#42)" : "Project (optional)" }

    static func addArgs(kind: HubRuleKind, threshold: String, scope: String, label: String) -> [String]? {
        var args = ["rules", "add", "--kind", kind.rawValue, "--json"]
        if let field = kind.threshold {
            guard let value = Double(threshold.trimmingCharacters(in: .whitespaces)), value > 0 else { return nil }
            args += [field.flag, value.rounded() == value ? String(Int(value)) : String(value)]
        }
        let scope = scope.trimmingCharacters(in: .whitespaces)
        if !scope.isEmpty {
            args += [kind.scopeFlag, scope]
        }
        let label = label.trimmingCharacters(in: .whitespaces)
        if !label.isEmpty {
            args += ["--label", label]
        }
        return args
    }
}

@MainActor
final class HubRulesModel: ObservableObject {
    @Published private(set) var list: HubRulesList?
    @Published private(set) var test: HubRulesRun?
    @Published private(set) var busy = false
    @Published var notice: String?
    /// The PR lookup cache setting shown in the same panel (the hub has no other settings view).
    @Published var prCacheSeconds = ""

    func load() {
        Task { await reload() }
        Task {
            if let values = try? await HubDailyCLI.decode(HubConfigValues.self, ["config", "get", "--json"], span: "hub.config.get") {
                prCacheSeconds = String(values.prLookupCacheSeconds)
            }
        }
    }

    func savePrCache() {
        guard let seconds = Int(prCacheSeconds.trimmingCharacters(in: .whitespaces)), seconds >= 0 else {
            notice = "Failed: the PR lookup cache takes whole seconds, 0 or more."
            return
        }
        busy = true
        Task {
            do {
                try await HubDailyCLI.run(["config", "set", "--pr-lookup-cache-seconds", String(seconds)], span: "hub.config.set")
                notice = seconds == 0 ? "PR lookup cache off." : "PR lookup cache: \(seconds) s."
            } catch {
                notice = "Failed: \(error)"
            }
            busy = false
        }
    }

    private func reload() async {
        do {
            list = try await HubDailyCLI.decode(HubRulesList.self, ["rules", "list", "--json"], span: "rules.list")
        } catch {
            notice = "Could not read the rules: \(error)"
        }
    }

    private func write(_ args: [String], done: String) {
        busy = true
        Task {
            do {
                try await HubDailyCLI.run(args, span: "rules.write")
                notice = done
                test = nil
            } catch {
                notice = "Failed: \(error)"
            }
            await reload()
            busy = false
        }
    }

    func add(kind: HubRuleKind, threshold: String, scope: String, label: String) -> Bool {
        guard let args = HubRuleKind.addArgs(kind: kind, threshold: threshold, scope: scope, label: label) else {
            notice = "\(kind.title) needs a positive \(kind.threshold?.label ?? "value")."
            return false
        }
        write(args, done: "Rule added. The first check takes a baseline: only what happens after it notifies.")
        return true
    }

    func toggle(_ rule: HubRule) {
        write(["rules", "set", rule.id, "--enabled", rule.enabled ? "off" : "on"], done: rule.enabled ? "Rule off." : "Rule on.")
    }

    func remove(_ rule: HubRule) {
        write(["rules", "rm", rule.id], done: "Rule removed.")
    }

    func runTest() {
        busy = true
        Task {
            do {
                test = try await HubDailyCLI.decode(HubRulesRun.self, ["rules", "test", "--json"], span: "rules.test")
            } catch {
                notice = "Test failed: \(error)"
            }
            busy = false
        }
    }
}

struct HubRulesPanel: View {
    let close: () -> Void
    @StateObject private var model = HubRulesModel()
    @State private var kind: HubRuleKind = .idle
    @State private var threshold = ""
    @State private var scope = ""
    @State private var label = ""

    var body: some View {
        HubDailyCard(width: 640, close: close) {
            HStack(spacing: 8) {
                Image(systemName: "bell.badge").foregroundColor(Color.jarvisTeal)
                Text("Notification rules").font(.system(size: 14, weight: .semibold))
                if model.busy {
                    ProgressView().controlSize(.small)
                }
                Spacer()
                Button("Test now") { model.runTest() }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 12))
                    .disabled(model.busy || (model.list?.rules.isEmpty ?? true))
                    .instantTooltip("Evaluate every rule now and show what would notify; posts nothing (tools hub rules test)")
                IconButton(systemName: "xmark", tooltip: "Close (Esc)", size: 10, action: close)
            }
            .padding(12)
            Text("Checked on every tick of the hub-pr-notify daemon task (tools hub notify install), also while the hub is closed.")
                .font(.system(size: 11))
                .foregroundColor(.settingsTextMuted)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            if let notice = model.notice {
                NoticePill(text: notice, isError: notice.hasPrefix("Failed") || notice.hasPrefix("Could not") || notice.hasPrefix("Test failed")) { model.notice = nil }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
            Divider().background(Color.jarvisBorder)
            VStack(alignment: .leading, spacing: 2) {
                if let rules = model.list?.rules, !rules.isEmpty {
                    ForEach(rules) { rule in ruleRow(rule) }
                } else if model.list != nil {
                    Text("No rules yet. Add one below.").font(.system(size: 12)).foregroundColor(.settingsTextMuted).padding(.vertical, 6)
                }
            }
            .padding(12)
            if let test = model.test {
                Divider().background(Color.jarvisBorder)
                testResult(test).padding(12)
            }
            Divider().background(Color.jarvisBorder)
            addForm.padding(12)
            Divider().background(Color.jarvisBorder)
            HStack(spacing: 8) {
                Text("PR lookup cache (seconds)").font(.system(size: 12)).foregroundColor(.settingsText)
                TextField("60", text: $model.prCacheSeconds)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 60)
                    .onSubmit { model.savePrCache() }
                    .instantTooltip("How long a session click's PR lookup is cached; 0 turns it off (tools hub config set --pr-lookup-cache-seconds)")
                Button("Save") { model.savePrCache() }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 12))
                    .disabled(model.busy)
                    .instantTooltip("Save the PR lookup cache setting to the hub config")
                Spacer()
            }
            .padding(12)
        }
        .onAppear { model.load() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Notification rules"))
    }

    private func ruleRow(_ rule: HubRule) -> some View {
        HStack(spacing: 8) {
            Toggle("", isOn: Binding(get: { rule.enabled }, set: { _ in model.toggle(rule) }))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .instantTooltip(rule.enabled ? "Switch this rule off" : "Switch this rule on")
            Text(verbatim: model.list?.labels[rule.id] ?? rule.label ?? rule.kind)
                .font(.system(size: 12.5))
                .foregroundColor(rule.enabled ? Color.white.opacity(0.9) : ReviewPalette.dim)
                .lineLimit(1)
            Text(verbatim: HubRuleKind(rawValue: rule.kind)?.title ?? rule.kind)
                .font(.system(size: 10.5))
                .foregroundColor(.settingsTextMuted)
            Spacer()
            Text(verbatim: rule.id).font(.system(size: 10, design: .monospaced)).foregroundColor(.settingsTextMuted)
            IconButton(systemName: "trash", tooltip: "Remove this rule", size: 10.5) { model.remove(rule) }
        }
        .frame(minHeight: 26)
    }

    private func testResult(_ run: HubRulesRun) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Test (nothing posted)").font(.system(size: 11.5, weight: .semibold)).foregroundColor(.settingsText)
            if let skipped = run.skipped {
                Text(verbatim: skipped).font(.system(size: 11)).foregroundColor(.settingsTextMuted)
            }
            ForEach(run.reports) { report in
                Text(verbatim: "\(report.label): \(report.problem ?? (report.seeded ? "\(report.matches) match now, the first check will take them as its baseline" : "\(report.matches) match, \(report.fired) would notify"))\(report.note.map { " · \($0)" } ?? "")")
                    .font(.system(size: 11))
                    .foregroundColor(report.problem == nil ? ReviewPalette.dim : ReviewPalette.removed)
            }
            ForEach(run.firings, id: \.self) { firing in
                Text(verbatim: "→ \(firing.title) · \(firing.subtitle) · \(firing.message)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Color.white.opacity(0.75))
                    .lineLimit(1)
            }
        }
    }

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Add").font(.system(size: 12, weight: .semibold)).foregroundColor(.settingsText)
                ForEach(HubRuleKind.allCases, id: \.self) { option in
                    HubDailyChip(title: option.title, on: kind == option) {
                        kind = option
                        threshold = ""
                    }
                }
            }
            HStack(spacing: 8) {
                if let field = kind.threshold {
                    TextField(field.placeholder, text: $threshold)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 70)
                        .instantTooltip("The \(field.label) that trips the rule")
                    Text(verbatim: field.label).font(.system(size: 11)).foregroundColor(.settingsTextMuted)
                }
                TextField(kind.scopePlaceholder, text: $scope)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 170)
                TextField("Name (optional)", text: $label)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 150)
                Spacer()
                Button("Add rule") {
                    if model.add(kind: kind, threshold: threshold.isEmpty ? (kind.threshold?.placeholder ?? "") : threshold, scope: scope, label: label) {
                        threshold = ""
                        scope = ""
                        label = ""
                    }
                }
                .buttonStyle(.genHoverPlain())
                .font(.system(size: 12, weight: .medium))
                .disabled(model.busy)
                .instantTooltip("tools hub rules add --kind \(kind.rawValue)")
            }
        }
    }
}
