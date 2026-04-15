import React, { useCallback, useMemo, useState } from 'react';
import { Datasource } from 'data/CHDatasource';
import { QueryType, QueryBuilderOptions, ColumnHint, StringFilter, NumberFilter, BuilderMode, FilterOperator, DateFilterWithoutValue, AggregateType, OrderByDirection } from 'types/queryBuilder';
import { CoreApp } from '@grafana/data';
import { LogsQueryBuilder } from './views/LogsQueryBuilder';
import { TimeSeriesQueryBuilder } from './views/TimeSeriesQueryBuilder';
import { TableQueryBuilder } from './views/TableQueryBuilder';
import { SqlPreview } from './SqlPreview';
import { DatabaseTableSelect } from 'components/queryBuilder/DatabaseTableSelect';
import { QueryTypeSwitcher } from 'components/queryBuilder/QueryTypeSwitcher';
import { styles } from 'styles';
import { TraceQueryBuilder } from './views/TraceQueryBuilder';
import { QueryStarter } from './QueryStarter';
import {
  BuilderOptionsReducerAction,
  setAllOptions,
  setBuilderMinimized,
  setDatabase,
  setQueryType,
  setTable,
} from 'hooks/useBuilderOptionsState';
import TraceIdInput from './TraceIdInput';
import { Alert, Button, VerticalGroup } from '@grafana/ui';
import { Components as allSelectors } from 'selectors';
import allLabels from 'labels';
import { CompactModeBar, CompactMode, getDefaultCompactMode } from './CompactModeBar';
import { CompactFilterBar } from './CompactFilterBar';
import { CompactAdvanced } from './CompactAdvanced';
import { CompactMetricsBar, MetricsBarState, getDefaultAggForTable } from './CompactMetricsBar';
import useColumns from 'hooks/useColumns';
import otel, { defaultMetricsTable, MetricsTableType } from 'otel';

interface QueryBuilderProps {
  app: CoreApp | undefined;
  builderOptions: QueryBuilderOptions;
  builderOptionsDispatch: React.Dispatch<BuilderOptionsReducerAction>;
  datasource: Datasource;
  generatedSql: string;
  onSwitchToSql?: () => void;
  onQueryChange?: (builderOptions: QueryBuilderOptions) => void;
}

export const QueryBuilder = (props: QueryBuilderProps) => {
  const { datasource, builderOptions, builderOptionsDispatch, generatedSql, onSwitchToSql, onQueryChange } = props;
  const signalType = datasource.getSignalType();
  const singleTableMode = datasource.isSingleTableMode();

  const onDatabaseChange = (database: string) => builderOptionsDispatch(setDatabase(database));
  const onTableChange = (table: string) => builderOptionsDispatch(setTable(table));
  const onQueryTypeChange = (queryType: QueryType) => builderOptionsDispatch(setQueryType(queryType));

  if (builderOptions.meta?.minimized) {
    return (
      <MinimizedQueryViewer
        builderOptions={builderOptions}
        builderOptionsDispatch={builderOptionsDispatch}
        datasource={datasource}
      />
    );
  }

  // Determine if this is a default/empty state
  const isDefaultState =
    builderOptions.queryType === QueryType.Table &&
    (!builderOptions.columns || builderOptions.columns.length === 0) &&
    (!builderOptions.filters || builderOptions.filters.length === 0) &&
    (!builderOptions.aggregates || builderOptions.aggregates.length === 0);

  // --- COMPACT MODE (single-table with signalType configured) ---
  if (singleTableMode && signalType) {
    // Detect mismatch: carried-over query from a different datasource/signal
    const expectedQueryType = signalType === 'logs' ? QueryType.Logs
      : signalType === 'traces' ? QueryType.Traces
      : signalType === 'metrics' ? QueryType.TimeSeries
      : undefined;
    const needsReinit = isDefaultState
      || (expectedQueryType && builderOptions.queryType !== expectedQueryType);

    return (
      <CompactQueryEditor
        key={datasource.uid}
        datasource={datasource}
        builderOptions={builderOptions}
        builderOptionsDispatch={builderOptionsDispatch}
        generatedSql={generatedSql}
        signalType={signalType}
        onSwitchToSql={onSwitchToSql}
        autoStart={needsReinit}
        onQueryChange={onQueryChange}
      />
    );
  }

  // --- MULTI-SIGNAL MODE ---

  // Landing page when user hasn't configured a query yet
  if (isDefaultState) {
    return (
      <div data-testid="query-editor-section-builder">
        <div className={'gf-form ' + styles.QueryEditor.queryType}>
          <DatabaseTableSelect
            datasource={datasource}
            database={builderOptions.database}
            onDatabaseChange={onDatabaseChange}
            table={builderOptions.table}
            onTableChange={onTableChange}
          />
        </div>
        <QueryStarter datasource={datasource} builderOptionsDispatch={builderOptionsDispatch} />
        <SqlPreview sql={generatedSql} onSwitchToSql={onSwitchToSql} />
      </div>
    );
  }

  // Full builder for multi-signal after query type is chosen
  return (
    <div data-testid="query-editor-section-builder">
      <div className={'gf-form ' + styles.QueryEditor.queryType}>
        <DatabaseTableSelect
          datasource={datasource}
          database={builderOptions.database}
          onDatabaseChange={onDatabaseChange}
          table={builderOptions.table}
          onTableChange={onTableChange}
        />
      </div>
      <div className={'gf-form ' + styles.QueryEditor.queryType}>
        <QueryTypeSwitcher queryType={builderOptions.queryType} onChange={onQueryTypeChange} />
      </div>

      {builderOptions.queryType === QueryType.Table && (
        <TableQueryBuilder
          datasource={datasource}
          builderOptions={builderOptions}
          builderOptionsDispatch={builderOptionsDispatch}
        />
      )}
      {builderOptions.queryType === QueryType.Logs && (
        <LogsQueryBuilder
          datasource={datasource}
          builderOptions={builderOptions}
          builderOptionsDispatch={builderOptionsDispatch}
        />
      )}
      {builderOptions.queryType === QueryType.TimeSeries && (
        <TimeSeriesQueryBuilder
          datasource={datasource}
          builderOptions={builderOptions}
          builderOptionsDispatch={builderOptionsDispatch}
        />
      )}
      {builderOptions.queryType === QueryType.Traces && (
        <TraceQueryBuilder
          datasource={datasource}
          builderOptions={builderOptions}
          builderOptionsDispatch={builderOptionsDispatch}
        />
      )}

      <SqlPreview sql={generatedSql} onSwitchToSql={onSwitchToSql} />
    </div>
  );
};

// --- Compact Query Editor (focused signal mode) ---

interface CompactQueryEditorProps {
  datasource: Datasource;
  builderOptions: QueryBuilderOptions;
  builderOptionsDispatch: React.Dispatch<BuilderOptionsReducerAction>;
  generatedSql: string;
  signalType: import('types/config').SignalType;
  onSwitchToSql?: () => void;
  autoStart?: boolean;
  onQueryChange?: (builderOptions: QueryBuilderOptions) => void;
}

const CompactQueryEditor = (props: CompactQueryEditorProps) => {
  const { datasource, builderOptions, builderOptionsDispatch, generatedSql, signalType, onSwitchToSql, autoStart, onQueryChange } = props;

  const defaultMode = getDefaultCompactMode(signalType, datasource);
  const [mode, setMode] = useState<CompactMode | undefined>(defaultMode);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const allColumns = useColumns(datasource, builderOptions.database || '', builderOptions.table || '');

  // Metrics bar state — kept in sync with builderOptions
  const [metricsState, setMetricsState] = useState<MetricsBarState>(() => ({
    tableType: (builderOptions.table as MetricsTableType) || (datasource.getDefaultMetricsTable() as MetricsTableType) || defaultMetricsTable,
    metricName: '',
    aggregateType: AggregateType.Average,
    groupBy: builderOptions.groupBy || ['ServiceName'],
  }));

  // Auto-start: initialize builder options for the signal type
  const handleStart = useCallback((m: CompactMode) => {
    const defaultDb = datasource.getDefaultDatabase() || '';
    let newOptions: QueryBuilderOptions | undefined;

    if (m === 'otel-logs') {
      const logsDb = datasource.getDefaultLogsDatabase() || defaultDb;
      const logsTable = datasource.getDefaultLogsTable() || '';
      const otelVersion = datasource.getLogsOtelVersion();
      const otelConfig = otelVersion ? otel.getVersion(otelVersion) : undefined;
      const columnMap = otelConfig?.logColumnMap;
      const columns = columnMap ? Array.from(columnMap, ([hint, name]) => ({ name, hint })) : [];

      newOptions = {
        database: logsDb,
        table: logsTable,
        queryType: QueryType.Logs,
        mode: BuilderMode.List,
        columns,
        filters: [{
          type: 'datetime',
          operator: FilterOperator.WithInGrafanaTimeRange,
          filterType: 'custom',
          key: '',
          hint: ColumnHint.FilterTime,
          condition: 'AND',
        } as DateFilterWithoutValue],
        orderBy: [],
        meta: {
          otelEnabled: Boolean(otelVersion),
          otelVersion: otelVersion || undefined,
        },
      };
    } else if (m === 'otel-metrics') {
      const metricsDb = datasource.getDefaultMetricsDatabase() || defaultDb;
      const metricsTable = datasource.getDefaultMetricsTable() || defaultMetricsTable;

      newOptions = {
        database: metricsDb,
        table: metricsTable,
        queryType: QueryType.TimeSeries,
        mode: BuilderMode.Trend,
        columns: [{ name: 'TimeUnix', hint: ColumnHint.Time }],
        aggregates: [{ aggregateType: AggregateType.Average, column: 'Value' }],
        filters: [{
          type: 'datetime',
          operator: FilterOperator.WithInGrafanaTimeRange,
          filterType: 'custom',
          key: '',
          hint: ColumnHint.Time,
          condition: 'AND',
        } as DateFilterWithoutValue],
        groupBy: ['ServiceName'],
        orderBy: [{ name: 'time', dir: OrderByDirection.ASC }],
        meta: {
          otelEnabled: true,
        },
      };
      // Remove limit for metrics — trend queries aggregate over full time range
      delete (newOptions as any).limit;
    } else if (m === 'otel-traces') {
      const tracesDb = datasource.getDefaultTraceDatabase() || defaultDb;
      const tracesTable = datasource.getDefaultTraceTable() || '';
      const otelVersion = datasource.getTraceOtelVersion();
      const otelConfig = otelVersion ? otel.getVersion(otelVersion) : undefined;
      const columnMap = otelConfig?.traceColumnMap;
      const columns = columnMap ? Array.from(columnMap, ([hint, name]) => ({ name, hint })) : [];

      newOptions = {
        database: tracesDb,
        table: tracesTable,
        queryType: QueryType.Traces,
        columns,
        filters: [
          {
            type: 'datetime',
            operator: FilterOperator.WithInGrafanaTimeRange,
            filterType: 'custom',
            key: '',
            hint: ColumnHint.Time,
            condition: 'AND',
          } as DateFilterWithoutValue,
          {
            type: 'string',
            operator: FilterOperator.IsEmpty,
            filterType: 'custom',
            key: '',
            hint: ColumnHint.TraceParentSpanId,
            condition: 'AND',
            value: '',
          } as StringFilter,
          {
            type: 'UInt64',
            operator: FilterOperator.GreaterThan,
            filterType: 'custom',
            key: '',
            hint: ColumnHint.TraceDurationTime,
            condition: 'AND',
            value: 0,
          } as NumberFilter,
          {
            type: 'string',
            operator: FilterOperator.IsAnything,
            filterType: 'custom',
            key: '',
            hint: ColumnHint.TraceServiceName,
            condition: 'AND',
            value: '',
          } as StringFilter,
        ],
        orderBy: [
          { name: '', hint: ColumnHint.Time, dir: OrderByDirection.DESC, default: true },
          { name: '', hint: ColumnHint.TraceDurationTime, dir: OrderByDirection.DESC, default: true },
        ],
        meta: {
          otelEnabled: Boolean(otelVersion),
          otelVersion: otelVersion || undefined,
          traceDurationUnit: otelConfig?.traceDurationUnit,
          flattenNested: otelConfig?.flattenNested,
          traceEventsColumnPrefix: otelConfig?.traceEventsColumnPrefix,
          traceLinksColumnPrefix: otelConfig?.traceLinksColumnPrefix,
        },
      };
    }

    if (newOptions) {
      builderOptionsDispatch(setAllOptions(newOptions));
      // Directly push to Grafana's query state to avoid stale-query race
      if (onQueryChange) {
        onQueryChange(newOptions);
      }
    }
  }, [datasource, builderOptionsDispatch, onQueryChange]);

  // Auto-start synchronously on first render when signalType doesn't match query
  // This MUST happen before the useEffect in CHEditorByType fires onChange with stale options
  const didAutoStart = React.useRef(false);
  if (autoStart && mode && !didAutoStart.current) {
    didAutoStart.current = true;
    handleStart(mode);
  }

  const onModeChange = (newMode: CompactMode) => {
    setMode(newMode);
    handleStart(newMode);
  };

  const searchText = builderOptions.meta?.logMessageLike || '';
  const onSearchChange = (text: string) => {
    builderOptionsDispatch(setAllOptions({
      ...builderOptions,
      meta: { ...builderOptions.meta, logMessageLike: text },
    }));
  };

  const handleSwitchToSql = () => {
    if (onSwitchToSql) {
      onSwitchToSql();
    }
  };

  const handleMetricsStateChange = (newState: MetricsBarState) => {
    setMetricsState(newState);
    const metricsDb = datasource.getDefaultMetricsDatabase() || datasource.getDefaultDatabase() || '';

    // Build MetricName filter
    const metricFilter: import('types/queryBuilder').Filter[] = newState.metricName
      ? [{
          type: 'string',
          operator: FilterOperator.Equals,
          key: 'MetricName',
          value: newState.metricName,
          condition: 'AND',
        } as import('types/queryBuilder').StringFilter]
      : [];

    // Preserve time filters from current options
    const timeFilters = (builderOptions.filters || []).filter(
      (f) => f.type === 'datetime' || f.hint === ColumnHint.Time || f.hint === ColumnHint.FilterTime
    );

    const newOptions: QueryBuilderOptions = {
      ...builderOptions,
      database: metricsDb,
      table: newState.tableType,
      aggregates: [{ aggregateType: newState.aggregateType, column: 'Value' }],
      filters: [...timeFilters, ...metricFilter],
      groupBy: newState.groupBy,
      orderBy: [{ name: 'time', dir: OrderByDirection.ASC }],
      limit: 0,
    };
    builderOptionsDispatch(setAllOptions(newOptions));
    if (onQueryChange) {
      onQueryChange(newOptions);
    }
  };

  const isMetrics = mode === 'otel-metrics';

  return (
    <div data-testid="query-editor-compact">
      <CompactModeBar
        datasource={datasource}
        signalType={signalType}
        mode={mode}
        onModeChange={onModeChange}
        searchText={searchText}
        onSearchChange={onSearchChange}
        onSearchSubmit={() => {}}
        onSwitchToSql={handleSwitchToSql}
        onToggleAdvanced={() => setAdvancedOpen(!advancedOpen)}
        advancedOpen={advancedOpen}
      />

      {isMetrics && (
        <CompactMetricsBar
          datasource={datasource}
          database={builderOptions.database || datasource.getDefaultDatabase() || ''}
          table={builderOptions.table || ''}
          state={metricsState}
          onChange={handleMetricsStateChange}
        />
      )}

      <CompactFilterBar
        datasource={datasource}
        database={builderOptions.database || ''}
        table={builderOptions.table || ''}
        filters={builderOptions.filters || []}
        allColumns={allColumns}
        onFiltersChange={(filters) => {
          builderOptionsDispatch(setAllOptions({
            ...builderOptions,
            filters,
          }));
        }}
      />

      {advancedOpen && (
        <CompactAdvanced
          builderOptions={builderOptions}
          allColumns={allColumns}
          onOrderByChange={(orderBy) => {
            builderOptionsDispatch(setAllOptions({ ...builderOptions, orderBy }));
          }}
          onLimitChange={(limit) => {
            builderOptionsDispatch(setAllOptions({ ...builderOptions, limit }));
          }}
        />
      )}

      <SqlPreview sql={generatedSql} onSwitchToSql={handleSwitchToSql} />
    </div>
  );
};

// --- Minimized Query Viewer (existing, for trace ID mode) ---

interface MinimizedQueryBuilder {
  builderOptions: QueryBuilderOptions;
  builderOptionsDispatch: React.Dispatch<BuilderOptionsReducerAction>;
  datasource: Datasource;
}

const MinimizedQueryViewer = (props: MinimizedQueryBuilder) => {
  const { builderOptions, builderOptionsDispatch, datasource } = props;
  const defaultColumns = useMemo<Map<ColumnHint, string> | undefined>(() => {
    if (builderOptions.queryType === QueryType.Logs) {
      return datasource.getDefaultLogsColumns();
    } else if (builderOptions.queryType === QueryType.Traces) {
      return datasource.getDefaultTraceColumns();
    }

    return undefined;
  }, [builderOptions.queryType, datasource]);
  const showConfigWarning = defaultColumns?.size === 0 && builderOptions.columns?.length === 0;
  const configQueryType =
    builderOptions.queryType === QueryType.Logs
      ? 'logs'
      : builderOptions.queryType === QueryType.Traces
        ? 'trace'
        : builderOptions.queryType;

  let traceId;
  if (
    builderOptions.queryType === QueryType.Traces &&
    builderOptions.meta?.isTraceIdMode &&
    builderOptions.meta.traceId
  ) {
    traceId = builderOptions.meta.traceId!;
  } else if (
    builderOptions.queryType === QueryType.Logs &&
    builderOptions.filters?.find((f) => f.hint === ColumnHint.TraceId && 'value' in f)
  ) {
    const traceIdFilter = builderOptions.filters?.find(
      (f) => f.hint === ColumnHint.TraceId && 'value' in f
    ) as StringFilter;
    traceId = traceIdFilter.value;
  }

  return (
    <div data-testid="query-editor-minimized-viewer">
      {showConfigWarning && (
        <Alert title="" severity="warning">
          <VerticalGroup>
            <div>
              {`To enable data linking, enter your default ${configQueryType} configuration in your `}
              <a
                style={{ textDecoration: 'underline' }}
                href={`/connections/datasources/edit/${encodeURIComponent(datasource.uid)}#${builderOptions.queryType}-config`}
              >
                ClickHouse Data Source settings
              </a>
            </div>
          </VerticalGroup>
        </Alert>
      )}
      {!traceId && (
        <Alert title="" severity="warning">
          <VerticalGroup>
            <div>Trace ID is empty</div>
          </VerticalGroup>
        </Alert>
      )}

      {traceId && <TraceIdInput traceId={traceId} onChange={() => {}} disabled />}

      <Button
        data-testid={allSelectors.QueryBuilder.expandBuilderButton}
        icon="plus"
        variant="secondary"
        size="md"
        onClick={() => builderOptionsDispatch(setBuilderMinimized(false))}
        className={styles.Common.smallBtn}
        tooltip={allLabels.components.expandBuilderButton.tooltip}
      >
        {allLabels.components.expandBuilderButton.label}
      </Button>
    </div>
  );
};
