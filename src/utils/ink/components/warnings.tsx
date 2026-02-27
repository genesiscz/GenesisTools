/**
 * Warnings — Bullet-pointed warning list
 */

import React from 'react';
import { Text, Box } from 'ink';
import { symbols, colors } from '../lib/theme.js';

export interface WarningsProps {
  warnings: string[];
  title?: string;
}

export function Warnings({ warnings, title = 'Warnings' }: WarningsProps) {
  if (warnings.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.warning} bold>
        {symbols.warning} {title}:
      </Text>
      {warnings.map((warning, i) => (
        <Text key={i} color={colors.warning}>
          {'  '}{symbols.bullet} {warning}
        </Text>
      ))}
    </Box>
  );
}
