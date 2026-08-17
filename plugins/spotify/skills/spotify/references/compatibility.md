# Taste compatibility: how it is computed, and how to read it

## What the number is

`tools spotify analytics compat a b` blends four measurements of the same window. Each is a similarity in
`[0, 1]`; the headline percentage is their weighted mean.

| Component | Weight | Measure | Answers |
|---|---|---|---|
| genre profile | 0.40 | cosine over play-weighted genre shares | do they live in the same musical space |
| artist overlap | 0.30 | weighted Jaccard over play-weighted artist shares | do they play the same artists, in similar proportion |
| shared top 50 | 0.15 | overlap coefficient over each side's 50 favourite artists | do their favourites intersect |
| exact songs | 0.15 | Jaccard over distinct song keys | do they play literally the same songs |

Genre carries the most weight because it survives two libraries that share no recordings at
all. Exact-song overlap carries the least: it punishes two people for owning the same music on
different releases, and it collapses toward zero for anyone with a large library, since
Jaccard divides by the union.

A song key is `title + artist`, lowercased. Using the track id instead would count a single
and its album version as different songs.

## Properties worth knowing

- **Symmetric.** `compat a b` equals `compat b a` exactly. Pinned by "compat is symmetric" in
  `src/spotify/tests/cli.test.ts`.
- **Self-compatibility is 1.0.** `compat a a` returns 100%. Pinned by "compat with yourself is
  1.0" in the same file.
- **Not a percentage of anything.** It is a blend of similarity coefficients, not "40% of your
  songs are the same". Do not paraphrase it that way.
- **Window-sensitive.** Restricting to a year compares two smaller, more concentrated
  profiles, which usually raises every component. Compare like with like.

## Calibration

Jaccard-based components are naturally small for real libraries, so the blended score reads
lower than intuition suggests. These bands are what the CLI prints as its closing line:

| Score | Reading |
|---|---|
| 60%+ | practically one library with two accounts |
| 40-60% | strong overlap with room to surprise each other |
| 22-40% | a real shared core surrounded by two separate worlds |
| 10-22% | mostly separate taste with a handful of bridges |
| under 10% | different musical universes |

Two people who genuinely listen together usually land in the 25-45% band. A number in the
teens is not a failure, and the components will show why: high genre cosine with near-zero
song overlap means the same taste expressed through different artists.

## Genre borrowing

Genres attach to artists, not tracks, and they come from MusicBrainz and Last.fm rather than
from Spotify. Whichever profile has enrichment data lends its tags to the other, so a partner
who only handed over a streaming-history export still gets a genre profile — as long as their
artists appear somewhere in the enriched library.

Where they do not overlap at all, the genre component drops and the score leans on the other
three. `tools spotify analytics top genres -p <them>` shows the coverage; if it is low, say so before quoting
the compatibility figure.

## Compatibility over time

```bash
tools spotify analytics compat me kaja --timeline --bucket quarter --min-plays 40
```

Each bucket is scored independently, from only the plays inside it. Buckets where either side
has fewer than `--min-plays` are left unscored rather than reported as a bad match — a quiet
quarter is missing data, not divergence. The table shows the genre and artist components next
to the blend, which is where the interesting movement usually is.

## The two playlist commands

**`blend a b`** ranks songs *both* have played by the harmonic mean of each side's normalised
play share. The harmonic mean is deliberate: it collapses toward zero when either side is
near zero, so a track one person loves and the other has heard twice cannot rank highly.
`--min` sets the floor for each side independently.

**`gift from to`** does the opposite. It takes songs `from` plays that `to` has **never**
played, and scores them by how much `to` already likes that artist and those genres:

```
score = love × (0.25 + 0.45 × √artistAffinity + 0.30 × √genreAffinity)
```

`love` is the sender's normalised play count, so it favours things they actually care about.
The square roots flatten the affinity terms, which keeps a beloved track by a merely-liked
artist competitive against a mediocre track by a favourite one. The 0.25 floor means a great
song can still surface for an artist the recipient has never touched.

Use `blend` for a shared session and `gift` for showing someone something new. When the
compatibility score is low, `gift` is the more useful of the two.
