# Comparison and decision pages

Use this guide when a page compares options (designs, vendors, approaches, plans), scores them against criteria, or
asks the reader to decide between them. It comes from a page that went wrong first. The options were letters, the
criteria were codes, and what each letter meant and how it scored were two sections apart. The reader asked "what is
R1?" and scrolled up and down to map every letter.

## The reader's questions, in order

1. **What won, and how sure are we?** The answer is the first section.
2. **What is each option?** One card per option, all visible at once.
3. **Why?** One table with every property and every score, and the reasons on hover.
4. **What do we decide now?** A short ordered list.

Method, history and raw records come last, folded.

## Names, never bare codes

- Every option has a short name in words: "Generic core", "Module with a generated schema". A letter or number that
  the scorers used is secondary. Show it in a kicker or as a tag prefix, never as the only label.
- **Show the code next to the name, never instead of it, and never alone.** A criterion is `R3 · Change safety ⓘ`,
  an option tag is `K · Generic core`, and prose says "change safety (R3)". The text report and the scorers' files use
  the codes, so a page without them cannot be mapped back to its sources; a code without its name sends the reader
  to a key.
- Every code carries a `Tooltip` with its full meaning. That covers an option letter, a criterion id, a question id
  and an abbreviation.
- Put a `Legend` under the `Hero` (as its child). It lists each option tag with its owner or source, and each tag in
  it is a tooltip with that option's summary.
- **Test:** a reader who lands in the middle of the page can read any sentence without scrolling to a key.

## Layout

| Section | Components | What it holds |
|---|---|---|
| Hero | `Hero` + `Legend` | The verdict in the title, one sentence of method, the option tags |
| Answer | `StatGrid`, `Claim` (confidence and proof), one `Callout` | The winner, the reader's own option, the condition that changes the result, how well the scorers agree |
| Options at a glance | `CardGrid` of `Card`, then `Tabs` of `Mermaid` | Per card: `kicker` (owner and code), `title` (the name), the body (a one-sentence idea), `fields` (the 3 or 4 properties that differ), `note` (the score), `footer` (the ranks as `Badge pill`), `highlight` on the winner. One diagram per option, the tab labelled by the name. |
| One table | `DataTable` | Options as columns. Upper rows: what each option is. Lower rows: the score per criterion, then sums and ranks. Never split "what it is" and "how it scored" into two sections. |
| Why | `Compare` | The winner against the runner-up, and against the reader's own option, titled by names |
| Cost, decide | `Callout`, `Bullets ordered` | What the winner costs, the fix, the decisions in order |
| Background | `Collapse` blocks | Method, what changed since the last version, raw records |

## Tooltips carry the evidence

- **A score cell** is a `Tooltip` whose rows give each scorer's score and one-sentence reason. The cell shows the
  scores; the reason is one hover away.
- **A criterion label** is a `Tooltip` with the criterion's full description and its scale.
- **An option tag** is a `Tooltip` with the option's summary: idea, owner, copies, score, rank, strength, weakness.
- `Tooltip` needs ONE child element that takes the pointer handlers. Wrap a `Badge` in a `<span>`.
- `DataTableColumn.label` is a string. Put the option names in the headers, and the tooltip tags in the first row of
  the table ("Option (hover for a summary)").

```tsx
const ScoreCell = ({ option, criterion }: { option: OptionId; criterion: CriterionId }) => {
	const entry = SCORES.options[option][criterion];
	const values = SCORERS.map((scorer) => entry[scorer].score);
	const average = values.reduce((total, value) => total + value, 0) / values.length;

	return (
		<Tooltip
			content={{
				title: `${CRITERIA[criterion].name}: ${OPTIONS[option].name}`,
				subtitle: CRITERIA[criterion].description,
				rows: SCORERS.map((scorer) => ({ k: `${LABEL[scorer]}: ${entry[scorer].score}`, v: entry[scorer].reason })),
			}}
		>
			<span>
				<Badge tone={average >= 4.5 ? "ok" : average >= 3.5 ? "info" : average >= 2.5 ? "warn" : "err"}>
					{values.join(" · ")}
				</Badge>
			</span>
		</Tooltip>
	);
};
```

## Data

- Keep scores and reasons out of the TSX. A script reads the source files (each scorer's table) and writes
  `<entry>.scores.json` next to the page, and the page imports it (`import SCORES from "./<entry>.scores.json"`). A
  single-file build bundles a static JSON import.
- The script checks every sum against the totals that the report states, and it fails on a mismatch.
- The page computes sums and ranks from the JSON. Never type a total by hand.
- When the text of an option was wrong and it was scored again, keep the old scorer files. The page shows the current
  scores and says in the background what changed.

## Width

- `Badge tag` is mono and does not wrap. In a table with five or more columns, a long tag in a cell makes the table
  wider than the page, and the last columns scroll out of view.
- In table cells, use short tags (code and owner). Show a criterion label as plain text with an "ⓘ" mark. Keep the
  long names in the headers, the cards and the legend.
- **Check:** in a 1200 px window, `table.scrollWidth <= table.parentElement.clientWidth`.

## JSX traps

Each of these broke a page in practice.

- Markdown text with `{` in JSX children, such as `` `{ product: object }` ``, is parsed as a JSX expression. Write
  it as a string expression: ``{"The editor needs `{ schema, document }`."}``.
- A JSX attribute string cannot hold `\"`. Write `intro={'"By hand" means …'}`.

## Verify

1. **Compile:** `tools artifact build <entry> -o <scratch dir>/check.html`. An exit code of 0 is the proof. A `curl`
   of the served page answers 200 even when its module fails to transform, so a 200 proves nothing about the page.
2. **Run:** open the page in a browser (Playwright or Chrome DevTools) and wait for Mermaid to render. Then check
   three things:
   - the console has no errors;
   - one score tooltip shows its reasons when you hover it;
   - no table is wider than its frame.
