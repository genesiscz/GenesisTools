/**
 * WorkflowProgress — GitHub Actions workflow polling display.
 *
 * Shows the workflow name with a spinner while in progress, a checkmark
 * on success, or a cross on failure. Displays elapsed time.
 *
 * Usage:
 *   <WorkflowProgress
 *     workflowName="deploy-prod.yml"
 *     status="in_progress"
 *     elapsed={45000}
 *   />
 */

import React from 'react';
import { Text, Box } from 'ink';
import Spinner from 'ink-spinner';
import { theme, symbols } from '../lib/theme.js';
import { formatDuration } from '../lib/format.js';
import type { WorkflowRun } from '../lib/types.js';

type WorkflowStatus = WorkflowRun['status'] | 'waiting';

interface WorkflowProgressProps {
  workflowName: string;
  status: WorkflowStatus;
  conclusion?: WorkflowRun['conclusion'];
  url?: string;
  elapsed?: number;
}

function WorkflowIcon({
  status,
  conclusion,
}: {
  status: WorkflowStatus;
  conclusion?: WorkflowRun['conclusion'];
}) {
  // Completed workflow - show result
  if (status === 'completed') {
    if (conclusion === 'success') {
      return <Text color={theme.success}>{symbols.success}</Text>;
    }
    if (conclusion === 'failure') {
      return <Text color={theme.error}>{symbols.error}</Text>;
    }
    if (conclusion === 'cancelled') {
      return <Text color={theme.warning}>{symbols.warning}</Text>;
    }
    return <Text color={theme.muted}>{symbols.pending}</Text>;
  }

  // In progress or queued - spinner
  return (
    <Text color={theme.primary}>
      <Spinner type="dots" />
    </Text>
  );
}

function StatusLabel({
  status,
  conclusion,
}: {
  status: WorkflowStatus;
  conclusion?: WorkflowRun['conclusion'];
}) {
  if (status === 'waiting') {
    return <Text color={theme.muted}>Waiting for trigger...</Text>;
  }
  if (status === 'queued') {
    return <Text color={theme.warning}>Queued</Text>;
  }
  if (status === 'in_progress') {
    return <Text color={theme.primary}>Running</Text>;
  }
  if (status === 'completed') {
    if (conclusion === 'success') {
      return <Text color={theme.success}>Passed</Text>;
    }
    if (conclusion === 'failure') {
      return <Text color={theme.error}>Failed</Text>;
    }
    if (conclusion === 'cancelled') {
      return <Text color={theme.warning}>Cancelled</Text>;
    }
    return <Text color={theme.muted}>Completed</Text>;
  }
  return null;
}

export function WorkflowProgress({
  workflowName,
  status,
  conclusion,
  url,
  elapsed,
}: WorkflowProgressProps) {
  return (
    <Box gap={1}>
      <WorkflowIcon status={status} conclusion={conclusion} />
      <Text bold>{workflowName}</Text>
      <StatusLabel status={status} conclusion={conclusion} />
      {elapsed !== undefined && elapsed > 0 && (
        <Text color={theme.muted}>({formatDuration(elapsed)})</Text>
      )}
      {url && status === 'completed' && conclusion === 'failure' && (
        <Text color={theme.muted} dimColor>
          {symbols.arrow} {url}
        </Text>
      )}
    </Box>
  );
}
