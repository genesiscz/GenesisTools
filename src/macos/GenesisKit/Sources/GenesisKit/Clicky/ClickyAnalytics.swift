import Combine
import Foundation

public struct ClickyActivityBucket: Codable, Equatable, Sendable {
    public var presses = 0
    public var releases = 0
    public init(presses: Int = 0, releases: Int = 0) { self.presses = presses; self.releases = releases }
    mutating func record(release: Bool) {
        if release { releases += 1 } else { presses += 1 }
    }
}

public enum ClickyTimeResolution: String, CaseIterable, Identifiable {
    case minute = "Minute", hour = "Hour", day = "Day"
    public var id: Self { self }
    var seconds: TimeInterval { switch self { case .minute: return 60; case .hour: return 3600; case .day: return 86400 } }
    var initialWindow: TimeInterval { switch self { case .minute: return 3600; case .hour: return 86400; case .day: return 7 * 86400 } }
}

@MainActor
public final class ClickyAnalyticsStore: ObservableObject {
    @Published public private(set) var snapshot = ClickyStatistics()
    public private(set) var revision: UInt64 = 0
    private var publishTask: Task<Void, Never>?

    func stage(_ source: @escaping @MainActor () -> ClickyStatistics?) {
        guard publishTask == nil else { return }
        publishTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            self?.flush(source())
        }
    }

    func flush(_ statistics: ClickyStatistics?) {
        publishTask?.cancel()
        publishTask = nil
        if let statistics {
            revision &+= 1
            snapshot = statistics
        }
    }
}

extension ClickyStatistics {
    func timeline(_ resolution: ClickyTimeResolution, releases: Bool = false) -> [NativeTimePoint] {
        let source: [Int: ClickyActivityBucket]
        let multiplier: Double
        switch resolution {
        case .minute: source = minutes; multiplier = 60
        case .hour: source = hours; multiplier = 3600
        case .day: source = days; multiplier = 1
        }
        return source.map { NativeTimePoint(date: Date(timeIntervalSince1970: Double($0.key) * multiplier),
            value: Double(releases ? $0.value.releases : $0.value.presses)) }.sorted { $0.date < $1.date }
    }

    func weekdayHeatmap(calendar: Calendar = .current) -> [NativeHeatmapCell] {
        var totals: [Int: Double] = [:]
        for (hour, bucket) in hours {
            let date = Date(timeIntervalSince1970: Double(hour) * 3600)
            let weekday = (calendar.component(.weekday, from: date) + 5) % 7
            let column = calendar.component(.hour, from: date)
            totals[weekday * 24 + column, default: 0] += Double(bucket.presses)
        }
        return (0..<7).flatMap { row in (0..<24).map { column in
            NativeHeatmapCell(row: row, column: column, value: totals[row * 24 + column, default: 0])
        } }
    }

    static func example(now: Date = Date(), calendar: Calendar = .current) -> ClickyStatistics {
        var result = ClickyStatistics()
        let start = calendar.date(byAdding: .day, value: -14, to: calendar.startOfDay(for: now)) ?? now
        result.startedAt = start
        result.historyStartedAt = start
        for index in 0..<(15 * 24 * 60) {
            let date = start.addingTimeInterval(Double(index) * 60)
            guard date <= now else { break }
            let hourOfDay = calendar.component(.hour, from: date)
            guard index % 17 < 12 else { continue }
            let weekday = calendar.component(.weekday, from: date)
            let factor = (weekday == 1 || weekday == 7 ? 0.3 : 1.0) * ((8..<22).contains(hourOfDay) ? 1.0 : 0.12)
            let presses = Int((20 + 90 * abs(sin(Double(index) / 37))) * factor)
            let bucket = ClickyActivityBucket(presses: presses, releases: presses)
            result.minutes[Int(date.timeIntervalSince1970 / 60)] = bucket
            var performance = ClickyPerformanceBucket()
            performance.presses = presses
            performance.characters = Int(Double(presses) * 0.8)
            performance.corrections = Int(Double(presses) * 0.05)
            performance.activeSeconds = min(55, Double(performance.characters) / (3.3 + 1.2 * abs(sin(Double(index) / 50))))
            performance.bursts = presses > 0 ? 1 : 0
            result.performanceMinutes[Int(date.timeIntervalSince1970 / 60)] = performance
            result.performanceStartedAt = start
            let hour = Int(date.timeIntervalSince1970 / 3600)
            let day = Int(calendar.startOfDay(for: date).timeIntervalSince1970)
            result.hours[hour, default: ClickyActivityBucket()].presses += presses
            result.hours[hour, default: ClickyActivityBucket()].releases += presses
            result.days[day, default: ClickyActivityBucket()].presses += presses
            result.days[day, default: ClickyActivityBucket()].releases += presses
            result.presses += presses
            result.releases += presses
        }
        let positions = ClickyKeyLayout.rows.flatMap { $0 }
        let weights = positions.enumerated().map { ($0.element.code, 1 + ($0.offset * 13) % 31) }
        let total = weights.reduce(0) { $0 + $1.1 }
        for (code, weight) in weights { result.keys[code] = result.presses * weight / total }
        result.keys[49, default: 0] += result.presses - result.keys.values.reduce(0, +)
        return result
    }
}

public enum ClickyKeyLayout {
    public struct Key: Identifiable { public let code: Int; public let label: String; public var id: Int { code } }
    public static let rows: [[Key]] = [
        [(53,"Esc"),(122,"F1"),(120,"F2"),(99,"F3"),(118,"F4"),(96,"F5"),(97,"F6"),(98,"F7"),(100,"F8"),(101,"F9"),(109,"F10"),(103,"F11"),(111,"F12")],
        [(50,"`"),(18,"1"),(19,"2"),(20,"3"),(21,"4"),(23,"5"),(22,"6"),(26,"7"),(28,"8"),(25,"9"),(29,"0"),(27,"−"),(24,"="),(51,"⌫")],
        [(48,"⇥"),(12,"Q"),(13,"W"),(14,"E"),(15,"R"),(17,"T"),(16,"Y"),(32,"U"),(34,"I"),(31,"O"),(35,"P"),(33,"["),(30,"]"),(42,"\\")],
        [(57,"⇪"),(0,"A"),(1,"S"),(2,"D"),(3,"F"),(5,"G"),(4,"H"),(38,"J"),(40,"K"),(37,"L"),(41,";"),(39,"'"),(36,"↵")],
        [(56,"⇧"),(6,"Z"),(7,"X"),(8,"C"),(9,"V"),(11,"B"),(45,"N"),(46,"M"),(43,","),(47,"."),(44,"/"),(60,"⇧ R")],
        [(63,"Fn"),(59,"⌃"),(58,"⌥"),(55,"⌘"),(49,"Space"),(54,"⌘ R"),(61,"⌥ R"),(123,"←"),(126,"↑"),(125,"↓"),(124,"→")]
    ].map { $0.map { Key(code: $0.0, label: $0.1) } }
    public static func label(_ code: Int) -> String {
        rows.lazy.flatMap { $0 }.first { $0.code == code }?.label ?? "Key \(code)"
    }
}
