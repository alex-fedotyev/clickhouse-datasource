import React, { useState, useEffect } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon, Input, Select, Tooltip, Button } from '@grafana/ui';
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
  onSwitchToSql: () => void;
  onToggleAdvanced?: () => void;
  advancedOpen?: boolean;
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
  actions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    flex-shrink: 0;
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

export const CompactModeBar = (props: CompactModeBarProps) => {
  const {
    datasource,
    signalType,
    mode,
    onModeChange,
    searchText,
    onSearchChange,
    onSearchSubmit,
    onSwitchToSql,
    onToggleAdvanced,
    advancedOpen,
  } = props;
  const styles = useStyles2(getStyles);
  const [localSearch, setLocalSearch] = useState(searchText);
  const modeOptions = getModeOptions(signalType, datasource);
  const showModeDropdown = !signalType && modeOptions.length > 1;
  const isLogs = mode === 'otel-logs';
  const isTraces = mode === 'otel-traces';
  const isMetrics = mode === 'otel-metrics';

  useEffect(() => {
    setLocalSearch(searchText);
  }, [searchText]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSearchChange(localSearch);
      onSearchSubmit();
    }
  };

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

      <div className={styles.actions}>
        {onToggleAdvanced && (
          <Tooltip content={advancedOpen ? 'Hide advanced options' : 'Show advanced options'}>
            <Button
              icon="cog"
              aria-label={advancedOpen ? 'Hide advanced options' : 'Show advanced options'}
              variant="secondary"
              size="sm"
              fill={advancedOpen ? 'solid' : 'text'}
              onClick={onToggleAdvanced}
            />
          </Tooltip>
        )}
        <Tooltip content="Open query history (Ctrl+H in Explore)">
          <Button
            icon="history"
            aria-label="Open query history"
            variant="secondary"
            size="sm"
            fill="text"
            onClick={() => {
              // Trigger Grafana's built-in query history panel via keyboard shortcut
              const event = new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true });
              document.dispatchEvent(event);
            }}
          />
        </Tooltip>
        <Tooltip content="Switch to SQL editor">
          <Button
            icon="pen"
            variant="secondary"
            size="sm"
            fill="text"
            onClick={onSwitchToSql}
          >
            SQL
          </Button>
        </Tooltip>
      </div>
    </div>
  );
};
