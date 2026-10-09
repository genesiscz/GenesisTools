import Foundation

// Persisted documents predate newer opt-in fields. Missing keys keep their declared defaults;
// malformed present values still fail decoding so FlowStore preserves the original file.

extension FlowConfig {
    enum CodingKeys: String, CodingKey {
        case enabled, activation, keyCode, modifiers, localeIdentifier
        case forceServerRecognition, trailingGraceMs, preRoll, injectViaPaste, restoreClipboard
        case muteSystemAudioWhileRecording, soundCues, dictionaryLearning, historyLimit, showPill
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? enabled
        activation = try values.decodeIfPresent(FlowActivation.self, forKey: .activation) ?? activation
        keyCode = try values.decodeIfPresent(UInt32.self, forKey: .keyCode) ?? keyCode
        modifiers = try values.decodeIfPresent(UInt32.self, forKey: .modifiers) ?? modifiers
        localeIdentifier = try values.decodeIfPresent(String.self, forKey: .localeIdentifier) ?? localeIdentifier
        forceServerRecognition = try values.decodeIfPresent(Bool.self, forKey: .forceServerRecognition) ?? forceServerRecognition
        trailingGraceMs = try values.decodeIfPresent(Int.self, forKey: .trailingGraceMs) ?? trailingGraceMs
        preRoll = try values.decodeIfPresent(Bool.self, forKey: .preRoll) ?? preRoll
        injectViaPaste = try values.decodeIfPresent(Bool.self, forKey: .injectViaPaste) ?? injectViaPaste
        restoreClipboard = try values.decodeIfPresent(Bool.self, forKey: .restoreClipboard) ?? restoreClipboard
        muteSystemAudioWhileRecording = try values.decodeIfPresent(Bool.self, forKey: .muteSystemAudioWhileRecording) ?? muteSystemAudioWhileRecording
        soundCues = try values.decodeIfPresent(Bool.self, forKey: .soundCues) ?? soundCues
        dictionaryLearning = try values.decodeIfPresent(Bool.self, forKey: .dictionaryLearning) ?? dictionaryLearning
        historyLimit = try values.decodeIfPresent(Int.self, forKey: .historyLimit) ?? historyLimit
        showPill = try values.decodeIfPresent(Bool.self, forKey: .showPill) ?? showPill
        guard historyLimit > 0 else {
            throw DecodingError.dataCorruptedError(forKey: .historyLimit, in: values, debugDescription: "History limit must be positive")
        }
        guard Self.trailingGraceRange.contains(trailingGraceMs) else {
            throw DecodingError.dataCorruptedError(forKey: .trailingGraceMs, in: values,
                                                   debugDescription: "Trailing grace must be 0 to \(Self.trailingGraceRange.upperBound) ms")
        }
    }
}

extension FlowTransform {
    enum CodingKeys: String, CodingKey {
        case name, prompt, id, enabled, appBundleIds
        case isDefault
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try values.decode(String.self, forKey: .name),
            prompt: try values.decode(String.self, forKey: .prompt)
        )
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? id
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? enabled
        appBundleIds = try values.decodeIfPresent([String].self, forKey: .appBundleIds) ?? appBundleIds
        isDefault = try values.decodeIfPresent(Bool.self, forKey: .isDefault) ?? isDefault
    }
}

extension FlowStats {
    enum CodingKeys: String, CodingKey {
        case totalWords, totalSeconds, sessionCount, dayStreak, lastDictationAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        totalWords = try values.decodeIfPresent(Int.self, forKey: .totalWords) ?? totalWords
        totalSeconds = try values.decodeIfPresent(Double.self, forKey: .totalSeconds) ?? totalSeconds
        sessionCount = try values.decodeIfPresent(Int.self, forKey: .sessionCount) ?? sessionCount
        dayStreak = try values.decodeIfPresent(Int.self, forKey: .dayStreak) ?? dayStreak
        lastDictationAt = try values.decodeIfPresent(Date.self, forKey: .lastDictationAt)
    }
}

extension FlowDictionaryRule {
    enum CodingKeys: String, CodingKey {
        case from, to, id, enabled, learned
        case createdAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            from: try values.decode(String.self, forKey: .from),
            to: try values.decode(String.self, forKey: .to)
        )
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? id
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? enabled
        learned = try values.decodeIfPresent(Bool.self, forKey: .learned) ?? learned
        createdAt = try values.decodeIfPresent(Date.self, forKey: .createdAt) ?? createdAt
    }
}

extension FlowSnippet {
    enum CodingKeys: String, CodingKey {
        case trigger, body, id, enabled
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            trigger: try values.decode(String.self, forKey: .trigger),
            body: try values.decode(String.self, forKey: .body)
        )
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? id
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? enabled
    }
}

extension FlowSuggestion {
    enum CodingKeys: String, CodingKey {
        case heard, suggested, reason, occurrences, id
        case firstSeen
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            heard: try values.decode(String.self, forKey: .heard),
            suggested: try values.decode(String.self, forKey: .suggested),
            reason: try values.decode(FlowSuggestionReason.self, forKey: .reason),
            occurrences: try values.decode(Int.self, forKey: .occurrences)
        )
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? id
        firstSeen = try values.decodeIfPresent(Date.self, forKey: .firstSeen) ?? firstSeen
    }
}

extension FlowEntry {
    enum CodingKeys: String, CodingKey {
        case text, rawText, targetBundleId, targetAppName, durationSeconds
        case injected, wordCount, id, createdAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            text: try values.decode(String.self, forKey: .text),
            rawText: try values.decode(String.self, forKey: .rawText),
            targetBundleId: try values.decodeIfPresent(String.self, forKey: .targetBundleId),
            targetAppName: try values.decodeIfPresent(String.self, forKey: .targetAppName),
            durationSeconds: try values.decode(Double.self, forKey: .durationSeconds),
            injected: try values.decode(Bool.self, forKey: .injected),
            wordCount: try values.decode(Int.self, forKey: .wordCount)
        )
        id = try values.decodeIfPresent(UUID.self, forKey: .id) ?? id
        createdAt = try values.decodeIfPresent(Date.self, forKey: .createdAt) ?? createdAt
    }
}
