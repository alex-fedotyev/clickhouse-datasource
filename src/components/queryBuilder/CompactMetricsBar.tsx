import React, { useEffect, useState, useCallback } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { useStyles2, Select, AsyncSelect } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { metricsTableTypes, MetricsTableType } from 'otel';
import { AggregateType } from 'types/queryBuilder';

export interface MetricsBarState {
  tableType: MetricsTableType;
  metricName: string;
  aggregateType: AggregateType;
  groupBy: string[];
}

interface CompactMetricsBarProps {
  datasource: Datasource;
  database: string;
  table: string;
  state: MetricsBarState;
  onChange: (state: MetricsBarState) => void;
}

const tableTypeOptions: Array<SelectableValue<MetricsTableType>> = metricsTableTypes.map((t) => ({
  label: t.label,
  value: t.value,
  description: t.description,
}));

const aggregateOptions: Array<SelectableValue<AggregateType>> = [
  { label: 'avg', value: AggregateType.Average },
  { label: 'sum', value: AggregateType.Sum },
  { label: 'min', value: AggregateType.Min },
  { label: 'max', value: AggregateType.Max },
  { label: 'count', value: AggregateType.Count },
  { label: 'p50', value: AggregateType.P50 },
  { label: 'p90', value: AggregateType.P90 },
  { label: 'p95', value: AggregateType.P95 },
  { label: 'p99', value: AggregateType.P99 },
];

/** Default aggregation per table type — mirrors established UX patterns */
export function getDefaultAggForTable(table: MetricsTableType): AggregateType {
  if (table === 'otel_metrics_sum') {
    return AggregateType.Sum;
  }
  return AggregateType.Average;
}

const getStyles = (theme: GrafanaTheme2) => ({
  bar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(0.5)} 0;
    flex-wrap: wrap;
  `,
});

/** Common OTEL groupBy suggestions shown first */
const defaultGroupBySuggestions = ['ServiceName', 'SpanName', 'SeverityText', 'StatusCode'];

export const CompactMetricsBar = (props: CompactMetricsBarProps) => {
  const { datasource, database, table, state, onChange } = props;
  const styles = useStyles2(getStyles);

  // Load available columns for groupBy suggestions
  const [groupByOptions, setGroupByOptions] = useState<Array<SelectableValue<string>>>([]);
  useEffect(() => {
    if (!database || !table) { return; }
    datasource.fetchColumns(database, table).then((cols) => {
      const stringCols = cols
        .filter(c => c.type?.match(/String|LowCardinality/i))
        .map(c => c.name);
      // Prioritize common OTEL columns, then alphabetical
      const sorted = [
        ...defaultGroupBySuggestions.filter(s => stringCols.includes(s)),
        ...stringCols.filter(s => !defaultGroupBySuggestions.includes(s)).sort(),
      ];
      setGroupByOptions(sorted.map(n => ({ label: n, value: n })));
    }).catch(() => setGroupByOptions([]));
  }, [datasource, database, table]);

  const loadMetricNames = useCallback(
    async (inputValue: string): Promise<Array<SelectableValue<string>>> => {
      try {
        const names = await datasource.fetchMetricNames(database, state.tableType);
        return names
          .filter((n) => !inputValue || n.toLowerCase().includes(inputValue.toLowerCase()))
          .map((n) => ({ label: n, value: n }));
      } catch {
        return [];
      }
    },
    [datasource, database, state.tableType]
  );

  const onTableTypeChange = (v: SelectableValue<MetricsTableType>) => {
    if (v.value) {
      onChange({
        ...state,
        tableType: v.value,
        metricName: '', // reset metric when table changes
        aggregateType: getDefaultAggForTable(v.value),
      });
    }
  };

  const onMetricNameChange = (v: SelectableValue<string>) => {
    onChange({ ...state, metricName: v.value || '' });
  };

  const onAggregateChange = (v: SelectableValue<AggregateType>) => {
    if (v.value) {
      onChange({ ...state, aggregateType: v.value });
    }
  };

  const onGroupByChange = (values: Array<SelectableValue<string>>) => {
    onChange({ ...state, groupBy: values.map(v => v.value!).filter(Boolean) });
  };

  const groupByValue = state.groupBy.map(g => ({ label: g, value: g }));

  return (
    <div className={styles.bar} data-testid="compact-metrics-bar">
      <Select
        options={tableTypeOptions}
        value={state.tableType}
        onChange={onTableTypeChange}
        width={16}
        prefix="Table"
      />
      <AsyncSelect
        key={state.tableType}
        loadOptions={loadMetricNames}
        defaultOptions
        value={state.metricName ? { label: state.metricName, value: state.metricName } : null}
        onChange={onMetricNameChange}
        width={36}
        placeholder="Select metric..."
        isClearable
        allowCustomValue
      />
      <Select
        options={aggregateOptions}
        value={state.aggregateType}
        onChange={onAggregateChange}
        width={12}
        prefix="Agg"
      />
      <Select
        isMulti
        options={groupByOptions}
        value={groupByValue}
        onChange={onGroupByChange}
        width={28}
        placeholder="Group by..."
        isClearable
        allowCustomValue
      />
    </div>
  );
};
