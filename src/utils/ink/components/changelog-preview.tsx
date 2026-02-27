/**
 * ChangelogPreview — Bordered changelog preview display.
 *
 * Renders the changelog inside a bordered box, grouped by commit type
 * with scope annotations.
 *
 * Usage:
 *   <ChangelogPreview groups={commitGroups} version="1.5.0" />
 */

import React from 'react';
import { Text, Box } from 'ink';
import { theme, symbols } from '../lib/theme.js';
import type { CommitGroup } from '../lib/types.js';

interface ChangelogPreviewProps {
  groups: CommitGroup[];
  version: string;
}

export function ChangelogPreview({ groups, version }: ChangelogPreviewProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={2}
      paddingY={1}
    >
      <Text color={theme.primary} bold>
        {symbols.changelog} Changelog Preview {symbols.dash} v{version}
      </Text>

      {groups.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>No changes to display.</Text>
        </Box>
      ) : (
        groups.map((group) => (
          <Box key={group.type} flexDirection="column" marginTop={1}>
            {/* Group header */}
            <Text bold>{group.title}</Text>

            {/* Commits in this group */}
            {group.commits.map((commit) => (
              <Box key={commit.hash} paddingLeft={1}>
                <Text color={theme.muted}>{symbols.bullet} </Text>
                {commit.scope && (
                  <Text color={theme.accent} bold>
                    {commit.scope}:{' '}
                  </Text>
                )}
                <Text>{commit.subject}</Text>
                <Text color={theme.muted}> ({commit.hash.slice(0, 7)})</Text>
              </Box>
            ))}
          </Box>
        ))
      )}
    </Box>
  );
}
