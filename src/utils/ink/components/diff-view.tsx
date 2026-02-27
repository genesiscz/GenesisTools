/**
 * DiffView -- Git-diff style output for seed dry-run
 *
 * Shows entity-level detail using the records[] array from AnalysisResult.
 * Green (+): new records to create
 * Yellow (~): records to update
 * Gray (-): records to skip (already exist, unchanged)
 */

import React from 'react';
import { Text, Box } from 'ink';
import type { AnalysisResult } from '#api/database/seeds/cli/types.js';

export interface DiffViewProps {
  results: AnalysisResult[];
  /** Show skip records (can be very verbose). Default false */
  showSkips?: boolean;
  /** Max records per entity to show. Default 20, 0 = unlimited */
  maxRecords?: number;
}

export function DiffView({ results, showSkips = false, maxRecords = 20 }: DiffViewProps) {
  if (results.length === 0) {
    return <Text dimColor>No changes to display</Text>;
  }

  return (
    <Box flexDirection="column" gap={1}>
      {results.map((result) => (
        <EntityDiff
          key={result.entity}
          result={result}
          showSkips={showSkips}
          maxRecords={maxRecords}
        />
      ))}

      {/* Summary footer */}
      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(40)}</Text>
      </Box>
      <DiffSummary results={results} />
    </Box>
  );
}

// -- Entity section -----------------------------------------------------------

interface EntityDiffProps {
  result: AnalysisResult;
  showSkips: boolean;
  maxRecords: number;
}

function EntityDiff({ result, showSkips, maxRecords }: EntityDiffProps) {
  const { entity, records, toCreate, toUpdate, toSkip } = result;

  // Filter records based on showSkips
  const visibleRecords = showSkips
    ? records
    : records.filter((r) => r.action !== 'skip');

  // Truncate if needed
  const truncated = maxRecords > 0 && visibleRecords.length > maxRecords;
  const displayRecords = truncated
    ? visibleRecords.slice(0, maxRecords)
    : visibleRecords;

  const remaining = visibleRecords.length - displayRecords.length;

  // Skip entities with no visible changes
  if (displayRecords.length === 0 && !showSkips) {
    if (toSkip > 0 && toCreate === 0 && toUpdate === 0) {
      return (
        <Box flexDirection="column">
          <EntityHeader entity={entity} toCreate={toCreate} toUpdate={toUpdate} toSkip={toSkip} />
          <Box paddingLeft={2}>
            <Text dimColor>All {toSkip} records unchanged</Text>
          </Box>
        </Box>
      );
    }
    return null;
  }

  return (
    <Box flexDirection="column">
      <EntityHeader entity={entity} toCreate={toCreate} toUpdate={toUpdate} toSkip={toSkip} />
      <Box flexDirection="column" paddingLeft={2}>
        {displayRecords.map((record, i) => (
          <RecordLine key={`${record.key}-${i}`} action={record.action} recordKey={record.key} reason={record.reason} />
        ))}
        {truncated && (
          <Text dimColor>  ... and {remaining} more</Text>
        )}
      </Box>
    </Box>
  );
}

// -- Entity header ------------------------------------------------------------

function EntityHeader({
  entity,
  toCreate,
  toUpdate,
  toSkip,
}: {
  entity: string;
  toCreate: number;
  toUpdate: number;
  toSkip: number;
}) {
  return (
    <Box>
      <Text bold color="white">{entity}</Text>
      <Text dimColor>{' ('}</Text>
      {toCreate > 0 && <Text color="green">+{toCreate}</Text>}
      {toCreate > 0 && (toUpdate > 0 || toSkip > 0) && <Text dimColor>, </Text>}
      {toUpdate > 0 && <Text color="yellow">~{toUpdate}</Text>}
      {toUpdate > 0 && toSkip > 0 && <Text dimColor>, </Text>}
      {toSkip > 0 && <Text dimColor>={toSkip}</Text>}
      <Text dimColor>{')'}</Text>
    </Box>
  );
}

// -- Record line --------------------------------------------------------------

function RecordLine({
  action,
  recordKey,
  reason,
}: {
  action: 'create' | 'update' | 'skip';
  recordKey: string;
  reason?: string;
}) {
  const prefix = action === 'create' ? '+' : action === 'update' ? '~' : ' ';
  const color = action === 'create' ? 'green' : action === 'update' ? 'yellow' : 'gray';

  return (
    <Box>
      <Text color={color}>{prefix} {recordKey}</Text>
      {reason && <Text dimColor> ({reason})</Text>}
    </Box>
  );
}

// -- Summary ------------------------------------------------------------------

function DiffSummary({ results }: { results: AnalysisResult[] }) {
  const totals = results.reduce(
    (acc, r) => ({
      create: acc.create + r.toCreate,
      update: acc.update + r.toUpdate,
      skip: acc.skip + r.toSkip,
    }),
    { create: 0, update: 0, skip: 0 },
  );

  const parts: React.ReactNode[] = [];

  if (totals.create > 0) {
    parts.push(
      <Text key="create" color="green">+{totals.create} to create</Text>,
    );
  }
  if (totals.update > 0) {
    parts.push(
      <Text key="update" color="yellow">~{totals.update} to update</Text>,
    );
  }
  if (totals.skip > 0) {
    parts.push(
      <Text key="skip" dimColor>={totals.skip} unchanged</Text>,
    );
  }

  return (
    <Box>
      <Text bold>Summary: </Text>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text dimColor>, </Text>}
          {part}
        </React.Fragment>
      ))}
    </Box>
  );
}
