/**
 * LogViewer — Color-coded log line display.
 *
 * Renders log lines with level-based coloring and optional timestamp/service.
 * Supports a maxLines prop to limit visible output (shows most recent).
 *
 * Usage:
 *   <LogViewer lines={logLines} maxLines={20} />
 */

import React from 'react';
import { Text, Box } from 'ink';
import { theme } from '../lib/theme.js';

export interface LogLine {
  timestamp?: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  service?: string;
}

interface LogViewerProps {
  lines: LogLine[];
  maxLines?: number;
}

const LEVEL_COLORS: Record<LogLine['level'], string | undefined> = {
  info: undefined, // default white
  warn: theme.warning,
  error: theme.error,
  debug: theme.muted,
};

const LEVEL_LABELS: Record<LogLine['level'], string> = {
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  debug: 'DBG',
};

export function LogViewer({ lines, maxLines }: LogViewerProps) {
  const visibleLines =
    maxLines && lines.length > maxLines
      ? lines.slice(-maxLines)
      : lines;

  if (visibleLines.length === 0) {
    return <Text color={theme.muted}>No log output.</Text>;
  }

  return (
    <Box flexDirection="column">
      {visibleLines.map((line, i) => {
        const color = LEVEL_COLORS[line.level];
        const label = LEVEL_LABELS[line.level];

        return (
          <Box key={i} gap={0}>
            {/* Timestamp */}
            {line.timestamp && (
              <Text color={theme.muted}>{line.timestamp} </Text>
            )}

            {/* Level badge */}
            <Text color={color} bold>
              {label}
            </Text>
            <Text> </Text>

            {/* Service tag */}
            {line.service && (
              <Text color={theme.primary}>[{line.service}] </Text>
            )}

            {/* Message */}
            <Text color={color}>{line.message}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
