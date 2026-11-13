import Foundation

/// Which project cards of Settings → Meetings → Projects are open. A card is folded until the reader opens it, and the
/// page opens it again on the next launch. The keys are project names, so a rename carries the open state over.
extension MeetingsPreferences {
    static let openProjectsKey = "meetings.settings.projects.open"

    static func openProjects(_ defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: openProjectsKey) ?? [])
    }

    static func setProject(_ name: String, open: Bool, _ defaults: UserDefaults = .standard) {
        var names = openProjects(defaults)
        if open { names.insert(name) } else { names.remove(name) }
        defaults.set(names.sorted(), forKey: openProjectsKey)
    }

    /// A rename keeps the card as it was.
    static func renameOpenProject(_ from: String, to: String, _ defaults: UserDefaults = .standard) {
        guard openProjects(defaults).contains(from) else { return }
        setProject(from, open: false, defaults)
        setProject(to, open: true, defaults)
    }
}

/// The one line a folded project card shows: what the project holds, so the reader knows which card to open.
enum ProjectCardSummary {
    /// "2 rules · 3 labels · 4 paired people · exports to Notes/acme", or "no rules yet · …" for a project with none.
    static func line(_ name: String, in settings: MeetingsSettings) -> String {
        line(settings.projects[name], folders: settings.wispr?.match[name]?.folders.count ?? 0)
    }

    /// The line of one project; `folders` is how many source folders put a meeting in it.
    static func line(_ project: ProjectSettings?, folders: Int) -> String {
        let rules = folders
            + (project?.match?.calendar?.calendars.count ?? 0)
            + (project?.match?.title?.words.count ?? 0)
        let labels = project?.labels.count ?? 0
        let people = project?.match?.people.count ?? 0
        var parts = [rules == 0 ? "no rules yet" : Plural.count(rules, "rule")]
        if labels > 0 { parts.append(Plural.count(labels, "label")) }
        if people > 0 { parts.append(Plural.count(people, "paired person", "paired people")) }
        if let folder = project?.export?.folder { parts.append("exports to \(shortFolder(folder))") }
        return parts.joined(separator: " · ")
    }

    /// The last two parts of a folder: "Notes/acme" for a deep path.
    static func shortFolder(_ path: String) -> String {
        let parts = path.split(separator: "/").map(String.init)
        return parts.suffix(2).joined(separator: "/")
    }
}
