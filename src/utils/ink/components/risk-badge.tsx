/**
 * RiskBadge — Colored background badge for risk levels
 */

import React from 'react';
import { Text } from 'ink';
import { getRiskBadge } from '../lib/theme.js';
import type { RiskLevel } from '../lib/theme.js';

export interface RiskBadgeProps {
  risk: RiskLevel;
}

export function RiskBadge({ risk }: RiskBadgeProps) {
  const badge = getRiskBadge(risk);
  return (
    <Text
      color={badge.color}
      backgroundColor={badge.backgroundColor}
      bold
    >
      {badge.label}
    </Text>
  );
}
