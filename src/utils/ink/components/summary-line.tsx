/**
 * SummaryLine — "X creates, Y updates, Z skips" with colors
 */

import React from 'react';
import { Text, Box } from 'ink';
import { symbols, colors } from '../lib/theme.js';
import { formatCount } from '../lib/format.js';
import type { AnalysisResult } from '#api/database/seeds/cli/types.js';

export interface SummaryLineProps {
  results: AnalysisResult[];
}

export function SummaryLine({ results }: SummaryLineProps) {
  const totals = results.reduce(
    (acc, r) => ({
      create: acc.create + r.toCreate,
      update: acc.update + r.toUpdate,
      skip: acc.skip + r.toSkip,
    }),
    { create: 0, update: 0, skip: 0 },
  );

  return (
    <Box marginTop={1}>
      <Text>
        {symbols.summary}{' '}
        <Text bold>Summary: </Text>
        <Text color={colors.create}>{formatCount(totals.create)} create</Text>
        <Text dimColor>, </Text>
        <Text color={colors.update}>{formatCount(totals.update)} update</Text>
        <Text dimColor>, </Text>
        <Text color={colors.skip}>{formatCount(totals.skip)} skip</Text>
      </Text>
    </Box>
  );
}
