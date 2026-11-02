/**
 * Every rule that can produce or score a meeting item. An item's `rules` lists the ones that applied, so a person can
 * see why it was suggested. Speaker rules are R* (transcript and attendance) and E* (the recording's evidence); the
 * rest score terms or mark who added an item. A stored record may hold an id that is no longer here; readers keep it
 * as a plain string.
 */
export enum MeetingRule {
    /**
     * RA, attendance. The platform's join and leave times (Teams per person, FaceTime for the whole call) say who was
     * in the call. A label whose person was not in the call during a range cannot be theirs; with one other person
     * present, the voice is that person. Confidence 0.95: attendance is a record, not a guess. Needs
     * `tools meetings attendance` or the automatic collection.
     */
    Attendance = "RA",
    /**
     * R1, leave phrase. A label says goodbye ("už musím", "mějte se", "I have to drop") and keeps talking afterwards,
     * so the later lines are someone else's voice under that label. Confidence 0.4 on its own. The phrases are
     * `LEAVE_PHRASES` in `@genesiscz/utils/transcribe/speakers`, whole words in Czech, Slovak and English.
     */
    LeavePhrase = "R1",
    /**
     * R5, talks after leaving. Always paired with R1: the lines of the label after its own goodbye form the
     * `speaker-range` item. The range ends at the label's next goodbye or its last line. Without R13 or R14 the item
     * stays low and becomes a listen question.
     */
    ContinuesAfterLeave = "R5",
    /**
     * R13, farewell answered. Another label answers the goodbye within 15 s ("čau", "měj se", "díky"), which confirms
     * that someone really left at that moment, so the label's later lines are a different voice. Raises an R1/R5 item
     * to 0.75.
     */
    FarewellAnswered = "R13",
    /**
     * R14, echoed farewell. The goodbye is only an echo ("taky", "já taky") of another label's goodbye said just
     * before. The person who leaves is the other label's, so this label is not the one leaving. Recorded as
     * `notThisPerson` in the item's evidence.
     */
    EchoedFarewell = "R14",
    /**
     * R15, label drift. An attendee is in the call but silent under their own label for 15 minutes or more, while
     * other labels talk. Their voice is probably filed under other labels. A hint in `speakers stats`; it does not
     * write an item by itself.
     */
    LabelDrift = "R15",
    /**
     * R16, arrival. Within 60 s after a person joins, a greeting ("čus", "ahoj", "zdravím") or a newcomer's question
     * ("o co jsem přišel", "slyšíte mě") under another label is theirs (0.65), and so is the line where the platform
     * first shows them speaking (0.55, catches a misheard "Plus." for "čus"). E1 or E3 against it lowers it to 0.35.
     */
    Arrival = "R16",
    /**
     * RM, muted. A person the platform shows muted in every reading over a line did not say it in the call. Muted
     * people are never candidates and never "shown speaking"; with one person left whom E3 shows, the line is theirs
     * (0.9). It never overrules E1: Wispr records the microphone itself, so a muted user can still be on it.
     */
    Muted = "RM",
    /**
     * E1, audio channel. The recorder keeps the user's microphone and the call's sound apart. A line the microphone
     * won (90 % or more) is the user, at most 0.95, lower on an echo of the call's words or a loud call; a line the
     * call won under the user's label is someone else. A mixed line asks to listen.
     */
    Channel = "E1",
    /**
     * E3, speaking indicator. The platform's own "who is speaking" readings (Teams, Google Meet through Wispr, about
     * every 5 s). Names a voice together with E4, or alone among the people present. Skipped for a platform without
     * an indicator (FaceTime). Teams never shows the user speaking, so E3 never counts against the user.
     */
    SpeakingIndicator = "E3",
    /**
     * E4, live name. The recorder's live voice id carries the platform's name for the call sound. It lags: a live id
     * keeps a departed person's name, so attendance (RA) and the speaking indicator (E3) overrule it. The weakest of
     * the evidence rules.
     */
    LiveName = "E4",
    /**
     * Energy. The audio's loudness per channel agrees with E1 (+0.05) or shows a loud call (-0.15). Used only when the
     * channel layout was calibrated on this recording's tagged segments (`evidence.channels`); a mono file or an
     * unknown layout leaves it out.
     */
    Energy = "energy",
    /**
     * Phonetic term. A word in the transcript sounds like a known term (the meeting's vocabulary, the dictionary, the
     * summary) but is spelled differently. The candidate list and its source are in the item's evidence. Owned by the
     * term check (`@genesiscz/utils/transcribe/terms`).
     */
    PhoneticTerm = "phonetic",
    /**
     * Dictionary fuzzy. A word whose stem (Czech endings stripped, `languages/cs.ts`) is close to a dictionary term or
     * one of its spoken forms. At `fuzzy.apply` or above it is replaced while rendering; between `fuzzy.suggest` and
     * `fuzzy.apply` it becomes a term item with the score as its confidence.
     */
    DictionaryFuzzy = "dictionary-fuzzy",
    /**
     * Summary name. The term check proposes a person's name that only the meeting's summary knows. It needs a
     * person's confirmation and is never applied by `--fix-term all`.
     */
    SummaryName = "summary-name",
    /**
     * Unknown word. No layer of the word check accepts the word (the spelling dictionary, the spoken word list and
     * its rules, English loan stems) and no vocabulary term matches it. Its weak candidates, if any, give
     * `proposed`; without one the item has no proposal and is asked as a free-text question. Owned by the term
     * check (`@genesiscz/utils/transcribe/languages/word-check`).
     */
    UnknownWord = "unknown-word",
    /**
     * Agent. An agent judged the item from the raw evidence (`tools meetings evidence --raw`) and the meeting's
     * context, and stored it with `items add` and a reason (`evidence.reason`). Its confidence is the agent's own.
     * It stays suggested, so a person still confirms it; a low one becomes a listen question like any other.
     */
    Agent = "agent",
    /**
     * User. The item was added by hand (`tools meetings items add`) with no reason, for example a question the
     * polisher wants answered by ear. No rule scored it, so it has no confidence.
     */
    User = "user",
}
