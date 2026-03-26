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
  groupByLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
});

/** Common OTEL groupBy suggestions shown first */
const defaultGroupBySuggestions = ['ServiceName', 'SpanName', 'SeverityText', 'StatusCode'];

export const CompactMetricsBar = (props: CompactMetricsBarProps) => {
  const { datasource, database, table, state, onChange } = props;
  const styles = useStyles2(getStyles);

  // Load available columns for groupBy suggestions
  const [allColumns, setAllColumns] = useState<Array<{name: string; type?: string}>>([]);
  const [groupByOptions, setGroupByOptions] = useState<Array<SelectableValue<string>>>([]);
  const [mapKeyOptions, setMapKeyOptions] = useState<Array<SelectableValue<string>>>([]);
  const [pendingMapColumn, setPendingMapColumn] = useState<string>('');

  useEffect(() => {
    if (!database || !table) { return; }
    datasource.fetchColumns(database, table).then((cols) => {
      setAllColumns(cols.map(c => ({ name: c.name, type: c.type })));
      const options: Array<SelectableValue<string>> = [];
      const stringCols: string[] = [];
      const mapCols: string[] = [];

      cols.forEach(c => {
        if (c.type?.startsWith('Map(')) {
          mapCols.push(c.name);
        } else if (c.type?.match(/String|LowCardinality/i)) {
          stringCols.push(c.name);
        }
      });

      // Prioritize common OTEL columns, then alphabetical string cols
      const sorted = [
        ...defaultGroupBySuggestions.filter(s => stringCols.includes(s)),
        ...stringCols.filter(s => !defaultGroupBySuggestions.includes(s)).sort(),
      ];
      sorted.forEach(n => options.push({ label: n, value: n }));
      // Add Map columns with [Map] hint — selecting triggers key picker
      mapCols.sort().forEach(n => options.push({ label: `${n} [Map]`, value: `__map__${n}`, description: 'Pick a key to group by' }));

      setGroupByOptions(options);
    }).catch(() => setGroupByOptions([]));
  }, [datasource, database, table]);

  // Load map keys when a Map column is selected for expansion
  useEffect(() => {
    if (!pendingMapColumn || !database || !table) {
      setMapKeyOptions([]);
      return;
    }
    datasource.fetchUniqueMapKeys(pendingMapColumn, database, table)
      .then(keys => setMapKeyOptions(keys.sort().map(k => ({ label: k, value: k }))))
      .catch(() => setMapKeyOptions([]));
  }, [datasource, database, table, pendingMapColumn]);

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

  // Group By: unified handler — regular columns added directly, Map columns (__map__ prefix) open key picker
  const onGroupByChange = (values: Array<SelectableValue<string>>) => {
    const newGroupBy: string[] = [];
    for (const v of values) {
      const val = v.value || '';
      if (val.startsWith('__map__')) {
        setPendingMapColumn(val.replace('__map__', ''));
        return;
      }
      newGroupBy.push(val);
    }
    onChange({ ...state, groupBy: newGroupBy.filter(Boolean) });
  };

  // Map key selected — add combined expression, keep selectors visible for further picks
  const [selectedMapKey, setSelectedMapKey] = useState<string>('');
  const onMapKeySelect = (v: SelectableValue<string>) => {
    if (v.value && pendingMapColumn) {
      const mapExpr = `${pendingMapColumn}['${v.value}']`;
      setSelectedMapKey(v.value);
      if (!state.groupBy.includes(mapExpr)) {
        onChange({ ...state, groupBy: [...state.groupBy, mapExpr] });
      }
    }
  };

  // Display labels for groupBy values — shorten Map expressions for tags
  const groupByValue = state.groupBy.map(g => {
    const mapMatch = g.match(/^(\w+)\['(.+)'\]$/);
    if (mapMatch) {
      return { label: `${mapMatch[1]}.${mapMatch[2]}`, value: g };
    }
    return { label: g, value: g };
  });

  return (
    <div className={styles.bar} data-testid="compact-metrics-bar">
      <Select
        options={tableTypeOptions}
        value={state.tableType}
        onChange={onTableTypeChange}
        width={18}
        prefix="Table"
      />
      <AsyncSelect
        key={state.tableType}
        loadOptions={loadMetricNames}
        defaultOptions
        value={state.metricName ? { label: state.metricName, value: state.metricName } : null}
        onChange={onMetricNameChange}
        width={40}
        placeholder="Select metric..."
        isClearable
        allowCustomValue
      />
      <Select
        options={aggregateOptions}
        value={state.aggregateType}
        onChange={onAggregateChange}
        width={14}
        prefix="Agg"
      />
      <span className={styles.groupByLabel}>Group by</span>
      <Select
        isMulti
        options={groupByOptions}
        value={groupByValue}
        onChange={onGroupByChange}
        width={32}
        placeholder="Column..."
        isClearable
        allowCustomValue
      />
      {pendingMapColumn && (
        <>
          <Select
            options={allColumns
              .filter(c => c.type?.startsWith('Map('))
              .map(c => ({ label: c.name, value: c.name }))}
            value={pendingMapColumn}
            onChange={(v) => {
              setPendingMapColumn(v.value || '');
              setSelectedMapKey('');
            }}
            width={22}
            prefix="Attr"
            isClearable
            onClear={() => { setPendingMapColumn(''); setSelectedMapKey(''); }}
          />
          <Select
            key={pendingMapColumn}
            options={mapKeyOptions}
            value={selectedMapKey || undefined}
            onChange={onMapKeySelect}
            width={28}
            placeholder="Select key..."
            prefix="Key"
            menuPlacement="bottom"
          />
        </>
      )}
    </div>
  );
};
