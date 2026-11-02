# Polishing rules

Each rule comes from a decision Martin made on 2026-11-02 (session `4ea826dd-e609-4ebc-9690-9ba4cc925167`, decisions
D1 to D18). Rules marked PENDING wait for his answer; apply the recommended option and mark it as a suggestion. The
meeting these rules were made on is worked through in a private example in the user's notes vault (real names, so it is
not in this repository).

## The polished file

ONE file, `<date>-<Title>.polished.md`, next to the untouched raw export. Sections, in this order:

1. **Front matter**: source and meeting id, share link, start and end (local time), created time to the minute, status
   (`draft`, `confirmed`).
2. **Participants**: invitees, roles, who attended, join and leave times, and the label map (raw label, real person,
   time range, confidence or `confirmed`).
3. **Glossary**: every term, path, identifier, interface and person the meeting names. Columns: correct form, the heard
   forms, kind (`fix`, `abbr`, `term`, `keep`), confidence or `confirmed`, source (document section, code file, data
   path), number of occurrences.
4. **References**: the documents the meeting discussed or read aloud (wiki page with its version, proposal numbers, code
   files, data files), each with the timestamps where it is used.
5. **Summary**: the source's summary, corrected against the polished transcript. Sub-sections: Decisions, Proposals,
   Open questions, Action items, Document impact. Every item has a timestamp and the person who said it (after speaker
   attribution: an action item often belongs to someone else than the source says).
6. **Summary diff** (`<details>`): the source's summary against the corrected one, as a `diff` block with a `//` reason
   and timestamp per changed line.
7. **Transcript** (`<details>`): the polished turns.
8. **Diffs** (`<details>`): one sub-section per kind (speakers, terms, quotes, removals), each a `diff` block with `//`
   lines for the evidence and the confidence.
9. **Unresolved**: every `[nejasné: ...]` with its timestamp.
10. **Open questions for the user**.

## How to find term errors

Work in this order; each pass finds what the previous ones miss.

1. **Read every line**, not only the tool's lists. The tool gives two: runs that sound like a vocabulary term, and words
   no layer of the word check knows (see below). Both are leads, not verdicts: ordinary spoken words land in the
   unknown list too ("byznysák"), and a real word used wrongly ("funkcionář" for a feature) passes the check.
2. **Build the project vocabulary first**: identifiers from the discussed documents and code (DTO and interface names,
   paths, fields, enum values), people from the invite, and the project dictionary.
3. **Look for these error shapes**:
   - an acronym with a Czech suffix and one wrong letter ("XYZčko" where the vocabulary has "XYčko");
   - an identifier spoken as syllables (an invented example: "géqúelko" for a `GQL_…` prefix; say the identifier aloud
     in Czech and compare);
   - a technology name glued to a Czech ending (invented: "Grafkůelem" for "GraphQL-em");
   - a nickname built from a person's syllables;
   - a word that is real Czech but makes no sense in its sentence ("funkcionář" where a feature is meant);
   - a person's name in the wrong grammatical case. Check every name against the verb before it, even when the person
     exists: "ptát se / zeptat se / neptat se" take the genitive ("zeptat se Pavla Nováka", invented example), so an
     accusative form after them is a mishearing, not a `keep`. A form suggested by the tool or the source's summary is
     not evidence;
   - a lower-case English word used as a place in a developer sentence ("na developu", "na masteru", invented
     examples): it names a branch or an environment, so write it as code (`develop`) with the meaning marker;
   - a domain value heard as a foreign word: check the data model's labels and codebooks (a heard English word can be the
     client's brand name in a list of offer types);
   - a garbled stretch where the speaker reads a document aloud (look for the document's section words around it).
4. **Work-item numbers**: when a speaker says a ticket number, fetch its title (`tools azure-devops wi <id> -f md`)
   before you judge the words around it; an odd abbreviation near it is often part of the title.
5. **Read-aloud passages**: when a speaker reads from a document, find the sentence in the document and propose it as a
   quote (D8). A strange abbreviation inside such a passage is usually the document's own word misheard.
6. **Keep real words** that only look odd (invented examples: "pushnu" is a Czech verb made from "push", "dlaždice" is a real domain word). Record them as
   `keep`, so the tool's false suggestion is visibly rejected.

## The word check

The term rules ask the word check whether a word is ordinary Czech before they compare it with the vocabulary. Each
word gets one verdict, and the raw dump shows it:

| Verdict | Meaning | Example |
|---|---|---|
| `dictionary` | The spelling dictionary knows it. A rare one (under 200 in the subtitles) is still compared with the vocabulary. | "kategorie" |
| `spoken` | People say it: 5 or more times in the OpenSubtitles word list, or a spoken ending whose written form the dictionary knows. | "jakej", "bysme" |
| `derived` | A Czech prefix on a known word. | "vysdílím" |
| `loan` | An English word, bare or under a Czech prefix and ending, or a developer word, or a meeting term. | "backendový", "UIčko" |
| `code` | A name or number from a screen. Ask what was shown. | "data.tile", "40px" |
| `fragment` | A word cut off mid-way. | "teoreti-" |
| `unknown` | No layer accepts it: misheard, a new term, or a spoken form the layers miss. | "proklizuje" |

The spell checker is a provider: `hunspell` (the default, the dictionary-cs Czech dictionary), `hunspell-cc0` (an
experimental CC0 dictionary) or `macos` (the system spell checker, macOS only). The dictionaries and the word list
download on first use to `~/.genesis-tools/downloads/transcribe/`. When the check cannot run, the tool says why and the
term rules skip every word with a Czech letter, as before.

## Term rules

- **Keep the words, add the meaning** (D1, D16): the original text stays and the meaning follows as
  `<sup>(…)</sup>`: "v tom get-u to lomeno type <sup>(`/{type}`)</sup>".
- **A path parameter is written as the speaker said it** (D2). When the meeting decides to change it, add the marker
  from the exact turn of the agreement on (D18): `{key} <sup>(Nově GUID)</sup>`.
- **Czech slang for technical words stays** (D5): "DTOčko", "APIčko", "BFFko", "UIčko". Fix only a misspelling. Use the
  exact identifier only when the speaker names one specific thing.
- **Business abbreviations are substituted, never translated to code values** (D7): the abbreviation stays and its
  meaning follows in `<sup>`. Take the substitutions from the project dictionary. PENDING D15: first occurrence only
  (recommended) or every occurrence.
- **What was on the screen wins** (D7): when the user says what the screen showed, write that. A token with a dot, a
  slash or an underscore in a passage about values or paths ("x.y", "a/b") was probably read from the screen: ask the
  user what was shown (or look up the screen record, `tools meetings screen --at`), and do not guess.
- **A fix stays in the speaker's language and register**: a misheard Czech word becomes the Czech word the speaker
  meant, not an English synonym (a Czech "funkcionář" that should mean a feature becomes "funkcionalita", not
  "feature").
- **Fix a word only when one reading fits the grammar and the context** (D9), and log the reason. Two possible readings
  make it an unclear item that always shows what is unclear: `[nejasné: "<raw>"; 1) <reading> 2) <reading>]`, never a
  bare `[nejasné]`. A word the user can settle by listening becomes a "listen" item (see speakers.md).
- **Show every guess before applying it** (D5): a list with the confidence and each occurrence in context (sentence
  before, the sentence with the term highlighted as `==term==`, sentence after). Propose the fixes at 70 % and above;
  the user confirms. A confirmed fix goes into the project dictionary with `tools meetings dictionary add <heard>
  <correct> --type fix --project <name>` (`term` for a correct word the check should know, `keep` for a real word the
  tool wrongly flags, `abbr` for a substitution), so the next meeting starts with it. Add each inflected form you met
  until the dictionary has fuzzy matching.

## Removals

- **Swearing and fillers stay** in the transcript and never go into the summary (D6).
- **Immediate repeats and cut-offs are removed** ("že všechny, že všechny" becomes "že všechny"; "A- a" becomes "A"),
  listed in a review file grouped by kind, confirmed per kind by the user, and shown in the Diffs section (D17).
  Interjections ("Jo. Jo.") stay.

## Summary

- **A decision is explicit agreement or a statement nobody objected to** (D10). Everything else is a proposal or an open
  question. Give each its exact scope, its timestamp, and a note when a later line contradicts it.
- **Re-check every person in the source's summary after speaker attribution.** An action item the source gives to one
  person is often another person's line.
- **Every claim of the source's summary is confirmed or corrected** with a timestamp, and the correction shows in the
  Summary diff. Ask during the rounds when a claim is ambiguous.

## Earlier example

An earlier meeting (Spellar, 2025) used the layout Attendees, Shortcuts/Terms, Transcript, and a follow-up document was
written from it. That session is no longer on disk. The
layout above replaces it.
