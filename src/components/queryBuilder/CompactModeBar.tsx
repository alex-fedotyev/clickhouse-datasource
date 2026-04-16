import React, { useState, useEffect } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon, Input, Select } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { SignalType } from 'types/config';

export type CompactMode = 'otel-logs' | 'otel-traces' | 'otel-metrics' | 'raw-sql';

interface CompactModeBarProps {
  datasource: Datasource;
  signalType: SignalType | undefined;
  /** Current active mode — controlled by parent */
  mode: CompactMode | undefined;
  onModeChange: (mode: CompactMode) => void;
  /** Log message search text */
  searchText: string;
  onSearchChange: (text: string) => void;
  onSearchSubmit: () => void;
}

const getStyles = (theme: GrafanaTheme2) => ({
  bar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(0.5)} 0;
  `,
  searchWrapper: css`
    flex: 1;
    min-width: 200px;
  `,
});

export function getDefaultCompactMode(
  signalType: SignalType | undefined,
  datasource: Datasource
): CompactMode | undefined {
  if (signalType === 'logs') {
    return 'otel-logs';
  }
  if (signalType === 'traces') {
    return 'otel-traces';
  }
  if (signalType === 'metrics') {
    return 'otel-metrics';
  }
  // For multi-signal, no default — show landing page
  return undefined;
}

export function getModeOptions(
  signalType: SignalType | undefined,
  datasource: Datasource
): Array<{ label: string; value: CompactMode; description?: string }> {
  const hasOtelLogs = Boolean(datasource.getLogsOtelVersion() && datasource.getDefaultLogsTable());
  const hasOtelTraces = Boolean(datasource.getTraceOtelVersion() && datasource.getDefaultTraceTable());
  const hasOtelMetrics = Boolean(datasource.getMetricsOtelVersion() && datasource.getDefaultMetricsTable());
  const options: Array<{ label: string; value: CompactMode; description?: string }> = [];

  if (signalType === 'logs' || (!signalType && hasOtelLogs)) {
    options.push({ label: 'OTEL Logs', value: 'otel-logs' });
  }
  if (signalType === 'traces' || (!signalType && hasOtelTraces)) {
    options.push({ label: 'OTEL Traces', value: 'otel-traces' });
  }
  if (signalType === 'metrics' || (!signalType && hasOtelMetrics)) {
    options.push({ label: 'OTEL Metrics', value: 'otel-metrics' });
  }
  if (!signalType) {
    options.push({ label: 'Raw SQL', value: 'raw-sql' });
  }
  return options;
}

/**
 * Signal-specific row of the compact query editor.
 * - Logs: search input
 * - Traces: nothing (returns null)
 * - Metrics: handled separately by CompactMetricsBar
 * - Multi-signal: mode dropdown
 *
 * Action buttons (gear, history, SQL) are NOT here — they live in CompactFilterBar.
 */
export const CompactModeBar = (props: CompactModeBarProps) => {
  const {
    datasource,
    signalType,
    mode,
    onModeChange,
    searchText,
    onSearchChange,
    onSearchSubmit,
  } = props;
  const styles = useStyles2(getStyles);
  const [localSearch, setLocalSearch] = useState(searchText);
  const modeOptions = getModeOptions(signalType, datasource);
  const showModeDropdown = !signalType && modeOptions.length > 1;
  const isLogs = mode === 'otel-logs';

  useEffect(() => {
    setLocalSearch(searchText);
  }, [searchText]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSearchChange(localSearch);
      onSearchSubmit();
    }
  };

  // Only render if there's signal-specific content to show
  if (!showModeDropdown && !isLogs) {
    return null;
  }

  return (
    <div className={styles.bar} data-testid="compact-mode-bar">
      {showModeDropdown && (
        <Select
          options={modeOptions}
          value={mode}
          onChange={(v) => v.value && onModeChange(v.value)}
          width={16}
          placeholder="Select mode..."
        />
      )}

      {isLogs && (
        <div className={styles.searchWrapper}>
          <Input
            value={localSearch}
            onChange={(e) => setLocalSearch(e.currentTarget.value)}
            onBlur={() => onSearchChange(localSearch)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search log body text..."
            prefix={<Icon name="search" />}
          />
        </div>
      )}
    </div>
  );
};
