/**
 * ErrorCard — Red bordered error display with action suggestions.
 *
 * Shows a prominent error box with title, message, and optional action hints.
 * Does NOT handle keyboard input — the parent component handles useInput.
 *
 * Usage:
 *   <ErrorCard
 *     title="Deployment Failed"
 *     message="API health check returned 503"
 *     actions={[
 *       { label: 'Retry', key: 'r', description: 'Try again' },
 *       { label: 'Rollback', key: 'b', description: 'Revert to previous' },
 *     ]}
 *   />
 */

import React from 'react';
import { Text, Box } from 'ink';
import { theme, symbols } from '../lib/theme.js';

interface ErrorAction {
  label: string;
  key: string;
  description: string;
}

interface ErrorCardProps {
  title: string;
  message: string;
  actions?: ErrorAction[];
}

export function ErrorCard({ title, message, actions }: ErrorCardProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.error}
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      {/* Title */}
      <Text color={theme.error} bold>
        {symbols.error} {title}
      </Text>

      {/* Message */}
      <Text>{message}</Text>

      {/* Actions */}
      {actions && actions.length > 0 && (
        <Box gap={2} marginTop={1}>
          {actions.map((action) => (
            <Box key={action.key}>
              <Text color={theme.muted}>[</Text>
              <Text color={theme.accent} bold>
                {action.key}
              </Text>
              <Text color={theme.muted}>]</Text>
              <Text> {action.label}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
