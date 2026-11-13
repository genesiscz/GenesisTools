import Foundation

extension MeetingsAPI {
    enum ListenPrepare: MeetingsServiceMethod {
        static let name = "meeting.listen.prepare"
        struct Params: Codable, Equatable { var meeting: String; var group: String; var count: Int?; var words: Int? }
        struct Result: Decodable { var meeting: String; var questions: [String] }
    }
    enum VoiceEnrol: MeetingsServiceMethod {
        static let name = "meeting.voice.enrol"
        struct Params: Codable, Equatable { var meeting: String }
        struct Result: Decodable { var samples: Int; var matched: Int; var unknown: Int }
    }
}

extension MeetingDetailModel {
    func prepareListenQuality(_ group: String, count: Int = 20, words: Int = 50) async throws {
        let flag = group == "spot-check" ? "--spot-check" : "--long-stretch-words"
        let number = group == "spot-check" ? count : words
        _ = try await PeopleCalls.write(MeetingsAPI.ListenPrepare.self,
            .init(meeting: id, group: group, count: group == "spot-check" ? number : nil, words: group == "long-stretch" ? number : nil),
            orRun: ["listen", id, flag, String(number), "--prepare-only"], service: service)
        reloadRecord()
        readRows(quiet: true)
    }

    func enrolListenVoices() async throws -> MeetingsAPI.VoiceEnrol.Result {
        let result = try await PeopleCalls.write(MeetingsAPI.VoiceEnrol.self, .init(meeting: id),
            orRun: ["listen", id, "--enrol-voices"], service: service)
        reloadRecord()
        loadTranscript()
        return result
    }
}

/// Mirrors the read-only threshold probe. The window already holds the scored lines; changing a threshold makes no service call.
enum ListenTranscriptQuality {
    struct Probe: Equatable { let applied: Int; let guesses: Int; let open: Int; let questions: Int }
    static func probe(_ entries: [TranscriptLine], percent: Int, minimumWords: Int = 50) -> Probe {
        let applied = entries.filter { $0.band == "confirmed" || ($0.suggestedSpeaker != nil && ($0.confidence ?? -1) * 100 >= Double(percent)) }.count
        let guessed = entries.enumerated().filter { _, line in
            line.band != "confirmed" && line.suggestedSpeaker != nil && (line.confidence ?? -1) >= 0.5 && (line.confidence ?? 1) * 100 < Double(percent)
        }
        var words = 0, last = -3, questions = 0
        for (index, line) in guessed where line.questioned != true {
            if index - last > 2 { if words >= minimumWords { questions += 1 }; words = 0 }
            words += line.text.split(whereSeparator: \.isWhitespace).count
            last = index
        }
        if words >= minimumWords { questions += 1 }
        return Probe(applied: applied, guesses: guessed.count, open: entries.count - applied, questions: questions)
    }
}
