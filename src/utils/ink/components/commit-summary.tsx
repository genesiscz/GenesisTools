/**
 * CommitSummary — Commit group statistics display.
 *
 * Shows grouped commit counts with colored numbers:
 *   3 Features, 2 Bug Fixes, 1 Breaking Change
 *
 * Usage:
 *   <CommitSummary groups={commitGroups} />
 */

import React from 'react';
import { Text, Box } from 'ink';
import { theme, symbols } from '../lib/theme.js';
import type { CommitGroup } from '../lib/types.js';

interface CommitSummaryProps {
  groups: CommitGroup[];
}

/** Map commit group types to display colors. */
function getGroupColor(type: string): string {
  switch (type) {
    case 'feat':
      return theme.success;
    case 'fix':
      return theme.warning;
    case 'breaking':
      return theme.error;
    case 'perf':
      return theme.info;
    case 'refactor':
      return theme.accent;
    default:
      return theme.muted;
  }
}

export function CommitSummary({ groups }: CommitSummaryProps) {
  if (groups.length === 0) {
    return <Text color={theme.muted}>No commits found.</Text>;
  }

  const totalCommits = groups.reduce((sum, g) => sum + g.commits.length, 0);

  return (
    <Box flexDirection="column" gap={0}>
      <Box gap={1}>
        <Text bold>{symbols.summary} Commits:</Text>
        <Text color={theme.primary} bold>
          {totalCommits}
        </Text>
        <Text color={theme.muted}>total</Text>
      </Box>

      <Box paddingLeft={2} gap={1} flexWrap="wrap">
        {groups.map((group, i) => {
          const color = getGroupColor(group.type);
          const isLast = i === groups.length - 1;

          return (
            <Box key={group.type}>
              <Text color={color} bold>
                {group.commits.length}
              </Text>
              <Text> {group.title}</Text>
              {!isLast && <Text color={theme.muted}>,</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
