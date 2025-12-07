# Report Creation Guide

This guide explains how to create a weekly work report table from Timely entries.

## Overview

The process transforms detailed Timely entries into a clean, organized markdown table showing work organized by weeks and days, with Czech descriptions of the actual work performed.

## Step-by-Step Process

### Step 1: Export Monthly Entries

First, export the entries for the target month using the Timely export command:

```bash
tools timely export-month <year-month> --format detailed-summary --silent
```

**Example:**

```bash
tools timely export-month 2025-09 --format detailed-summary --silent
```

This command will:

-   Generate `entries-<year-month>.json` - Raw JSON data with all entries
-   Generate `entries-<year-month>.md` - Detailed markdown file with all activities

**Important:** You'll work with the `.md` file to create the final table.

### Step 2: Understand the Source Data Structure

The `entries-<year-month>.md` file contains:

-   Date headers: `## DD. MM. YYYY`
-   Activity entries with time spent: `- Activity Name (Xh Ym)`
-   Sub-entries showing specific files/applications worked on
-   Task references (User Story IDs, Incident IDs, etc.)

**Key patterns to identify:**

-   Task IDs like `218568`, `170260`, `235086`, etc.
-   Task names like "MA – 1KLIK, chybné nastavení přeplatku k vyplacení"
-   Generic activities like "Incidenty OPEX", "Ostatní provoz - správa aplikací", "Provozní Scrum ceremonie"
-   File paths and application names that indicate what was worked on

### Step 3: Create the Table Structure

Create a markdown file `entries-<year-month>-table.md` with:

**Table Format:**

-   Two columns: `Week from` and `That week entries`
-   Week ranges in format: `**DD. MM. – DD. MM. YYYY**`
-   Days organized as: `**PO:**`, `**ÚT:**`, `**ST:**`, `**ČT:**`, `**PÁ:**`, `**SO:**`, `**NE:**`

**Example structure:**

```markdown
| Week from              | That week entries         |
| ---------------------- | ------------------------- |
| **1. 9. – 7. 9. 2025** | **PO:**<br>**ÚT:**<br>... |
```

### Step 4: Extract and Organize Entries by Week

For each week, you need to:

1. **Identify the week range** (e.g., September 1-7, 8-14, etc.)
2. **Map dates to days of the week** (PO=Monday, ÚT=Tuesday, ST=Wednesday, ČT=Thursday, PÁ=Friday, SO=Saturday, NE=Sunday)
3. **Group entries by day** based on the date headers in the source file

**Important considerations:**

-   September 2025 starts on a Monday (1.9. = Monday)
-   Some weeks may have partial entries (e.g., last week only has 2 days)
-   Empty days should still show the day header (e.g., `**PO:**`)

### Step 5: Transform Task Entries

For each task entry, you need to:

#### 5.1 Shorten Task Prefixes

**Original format:**

```
218568 - MA – 1KLIK, chybné nastavení přeplatku k vyplacení - SD32963 - EXT CAPEX (00042139)
```

**Shortened format:**

```
218568 - 1KLIK
```

**Rules:**

-   Keep the task ID number
-   Keep a short identifier (like "1KLIK", "BRQ011", "React 19 Upgrade")
-   Remove long descriptions, SD numbers, project codes, and hour values
-   For generic tasks, use short names: "Incidenty OPEX", "Ostatní provoz - správa aplikací", "Provozní Scrum ceremonie"

#### 5.2 Create Czech Descriptions

**DO NOT** list file names or technical details. Instead, create meaningful Czech descriptions based on what was actually worked on.

**Examples of good descriptions:**

-   "Práce na interaktivním vyúčtování, komponenty pro zobrazení přeplatku a nastavení způsobu vrácení"
-   "Práce na změně záloh, success label, finální zobrazení změny záloh"
-   "Práce na vrácení přeplatku, formulář pro nastavení způsobu platby, validace bankovního účtu"
-   "Analýza úkolu, práce na změně způsobu platby, změna záloh"
-   "React 19 Upgrade - Práce na nastavení záloh, TypeScript migrace, import manager"

**What to include:**

-   Main feature/functionality being worked on
-   Key activities (analysis, implementation, testing, migration, etc.)
-   Important meetings or reviews (Teams schůzky, GitLab MR review)
-   Related work (if working on multiple related features)

**What NOT to include:**

-   Individual file names (unless critical to understanding)
-   Technical implementation details
-   Hour values
-   Long lists of files

#### 5.3 Formatting Rules

**Line breaks:**

-   Use single `<br>` between items (NOT `<br><br>`)
-   Use `<br>` after day headers: `**PO:**<br>`
-   Use `<br>` between task entries on the same day

**Task entry format:**

```
- <TaskID> - <ShortName> - <Czech description>
```

**Example:**

```
- 218568 - 1KLIK - Práce na interaktivním vyúčtování, komponenty pro zobrazení přeplatku a nastavení způsobu vrácení
```

**Multiple tasks on same day:**

```
**PO:**<br>
- 218568 - 1KLIK - Práce na interaktivním vyúčtování<br>
- Incidenty OPEX - Řešení incidentů, analýza chyb<br>
- Ostatní provoz - správa aplikací<br>
- Provozní Scrum ceremonie
```

### Step 6: Handle Special Cases

#### Empty Days

If a day has no entries, still show the day header:

```
**PO:**<br>
**ÚT:**<br>
- Task entry here<br>
```

#### Notes

If there are notes about discrepancies or missing data, include them:

```
**8. 9. – 14. 9. 2025**<br><br>_Poznámka: Hlavička ukazuje součet 13,00h, ale viditelné položky dávají 11,00h. Zřejmě chybí drobná položka (např. Scrum) mimo výřez obrázku._
```

#### Days Without Visible Records

If a day has no visible entries in the source:

```
**ST:**<br>
(Bez viditelného záznamu v tabulce)
```

### Step 7: Review and Refine

After creating the table:

1. **Check completeness:** Ensure all days in all weeks are accounted for
2. **Verify descriptions:** Make sure Czech descriptions accurately reflect the work done
3. **Check formatting:** Ensure consistent use of `<br>` tags and proper markdown table syntax
4. **Verify task grouping:** Make sure tasks are correctly grouped by day and week

### Step 8: Generate PDF

Once the markdown table is complete, convert it to PDF:

```bash
md-to-pdf entries-<year-month>-table.md
```

**Example:**

```bash
md-to-pdf entries-2025-09-table.md
```

This will generate `entries-<year-month>-table.pdf` which can be used for reporting.

## Complete Example Workflow

```bash
# 1. Export entries for September 2025
tools timely export-month 2025-09 --format detailed-summary --silent

# 2. Review the generated entries-2025-09.md file
#    - Identify all dates and their corresponding days of week
#    - Group entries by week (1-7, 8-14, 15-21, 22-28, 29-30)
#    - Extract task IDs and create shortened prefixes
#    - Create Czech descriptions based on actual work

# 3. Create entries-2025-09-table.md with the table structure
#    - Two columns: Week from | That week entries
#    - Organize by weeks and days
#    - Use shortened task prefixes
#    - Write Czech descriptions
#    - Use single <br> between items

# 4. Convert to PDF
md-to-pdf entries-2025-09-table.md
```

## Key Principles

1. **Readability over completeness:** Better to have concise, readable descriptions than exhaustive lists
2. **Czech language:** All descriptions should be in Czech
3. **Meaningful descriptions:** Focus on what was done, not technical file names
4. **Consistent formatting:** Use the same format throughout the table
5. **Day organization:** Always organize by day (PO, ÚT, ST, ČT, PÁ, SO, NE) within each week
6. **No hours:** Don't show hours for individual lines (hours are only in the original report summary)

## Common Task Prefixes

Based on common patterns:

-   `218568 - 1KLIK` - MA – 1KLIK, chybné nastavení přeplatku k vyplacení
-   `170260 - BRQ011` - BRQ011 - Zobrazení informace o trvalé záloze
-   `235086` - Změna záloh send vs success
-   `233732 - React 19 Upgrade` - Upgrade projektů na React 19
-   `242244` - U reklamace typu stížnost chybí externí reference
-   `222023 - KK v3.0` - 2. etapa knihovna komponent v3.0
-   `147105 - BRQ002` - BRQ002 – Úprava v zobrazení doporučení na dlaždici OM
-   `Incidenty OPEX` - Generic incident handling
-   `Ostatní provoz - správa aplikací` - General application maintenance
-   `Provozní Scrum ceremonie` - Operational Scrum ceremonies

## Troubleshooting

**Problem:** Can't find entries for a specific date

-   Check if the date exists in the source file
-   Some dates might not have entries (weekends, holidays)
-   Use `(Bez viditelného záznamu v tabulce)` if no entries found

**Problem:** Too many file names in description

-   Focus on the feature/functionality being worked on
-   Group related files into a single description
-   Use generic terms like "komponenty", "formuláře", "Redux saga", etc.

**Problem:** Table formatting looks wrong

-   Ensure proper markdown table syntax with `|` separators
-   Check that `<br>` tags are used correctly (single, not double)
-   Verify column alignment with proper header separators

**Problem:** Week ranges don't match

-   Verify the first day of the month and which day of week it falls on
-   September 2025: 1.9. = Monday, so week 1 is 1-7, week 2 is 8-14, etc.
-   Last week might be partial (e.g., 29-30 for September)
