/**
 * VersionBadge — Colored version bump badge.
 *
 * Renders bump type with color coding:
 *   MAJOR in red, MINOR in yellow, PATCH in green.
 *
 * Usage:
 *   <VersionBadge bump="minor" />
 */

import React from 'react';
import { Text } from 'ink';
import { type BumpType, getBumpColor } from '../lib/theme.js';

interface VersionBadgeProps {
  bump: BumpType;
}

export function VersionBadge({ bump }: VersionBadgeProps) {
  return (
    <Text color={getBumpColor(bump)} bold>
      {bump.toUpperCase()}
    </Text>
  );
}
