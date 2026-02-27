/**
 * ErrorPanel — Full-width error box with suggestion and retry command
 *
 * Displays errors in a visually distinct red-bordered box with:
 * - Bold red title
 * - Wrapped error message (never truncated)
 * - Optional green suggestion text
 * - Optional cyan retry command
 */

import React from 'react';
import { Text, Box } from 'ink';

export interface ErrorPanelProps {
  title?: string;
  error: Error | string;
  suggestion?: string;
  retryCommand?: string;
}

export function ErrorPanel({
  title = 'Error',
  error,
  suggestion,
  retryCommand,
}: ErrorPanelProps) {
  const errorMessage = error instanceof Error ? error.message : error;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="red"
      paddingX={1}
      paddingY={0}
    >
      <Text bold color="red">
        {'\u2717'} {title}
      </Text>

      <Box marginTop={1}>
        <Text wrap="wrap">{errorMessage}</Text>
      </Box>

      {suggestion && (
        <Box marginTop={1}>
          <Text color="green">{'\u2192'} {suggestion}</Text>
        </Box>
      )}

      {retryCommand && (
        <Box marginTop={1}>
          <Text dimColor>Retry: </Text>
          <Text color="cyan" bold>{retryCommand}</Text>
        </Box>
      )}
    </Box>
  );
}
