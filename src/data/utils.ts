import { CoreApp, DataFrame, DataFrameType, DataQueryRequest, DataQueryResponse, FieldConfig, FieldType, NodeGraphDataFrameFieldNames } from '@grafana/data';
import {
  ColumnHint,
  FilterOperator,
  OrderByDirection,
  QueryBuilderOptions,
  QueryType,
  SelectedColumn,
  StringFilter,
} from 'types/queryBuilder';
import { CHBuilderQuery, CHQuery, EditorType } from 'types/sql';
import { Datasource } from './CHDatasource';
import { pluginVersion } from 'utils/version';
import { generateSql } from './sqlGenerator';
import otel from 'otel';

/**
 * Returns true if the builder options contain enough information to start showing a query
 */
export const isBuilderOptionsRunnable = (builderOptions: QueryBuilderOptions): boolean => {
  return (
    (builderOptions.columns?.length || 0) > 0 ||
    (builderOptions.filters?.length || 0) > 0 ||
    (builderOptions.orderBy?.length || 0) > 0 ||
    (builderOptions.aggregates?.length || 0) > 0 ||
    (builderOptions.groupBy?.length || 0) > 0
  );
};

/**
 * Converts QueryBuilderOptions to Grafana format
 * src: https://github.com/grafana/sqlds/blob/main/query.go#L20
 */
export const mapQueryBuilderOptionsToGrafanaFormat = (t?: QueryBuilderOptions): number => {
  switch (t?.queryType) {
    case QueryType.Table:
      return 1;
    case QueryType.Logs:
      return 2;
    case QueryType.TimeSeries:
      return 0;
    case QueryType.Traces:
      return t.meta?.isTraceIdMode ? 3 : 1;
    default:
      return 1 << 8; // an unused u32, defaults to timeseries/graph on plugin backend.
  }
};

/**
 * Converts QueryType to Grafana format
 * src: https://github.com/grafana/sqlds/blob/main/query.go#L20
 */
export const mapQueryTypeToGrafanaFormat = (t?: QueryType): number => {
  switch (t) {
    case QueryType.Table:
      return 1;
    case QueryType.Logs:
      return 2;
    case QueryType.TimeSeries:
      return 0;
    case QueryType.Traces:
      return 3;
    default:
      return 1 << 8; // an unused u32, defaults to timeseries/graph on plugin backend.
  }
};

/**
 * Converts Grafana format to builder QueryType
 * src: https://github.com/grafana/sqlds/blob/main/query.go#L20
 */
export const mapGrafanaFormatToQueryType = (f?: number): QueryType => {
  switch (f) {
    case 0:
      return QueryType.TimeSeries;
    case 1:
      return QueryType.Table;
    case 2:
      return QueryType.Logs;
    case 3:
      return QueryType.Traces;
    default:
      return QueryType.Table;
  }
};

/**
 * Manipulates column array in-place to include column hints, loosely matched by the provided column hint map.
 */
export const tryApplyColumnHints = (columns: SelectedColumn[], hintsToColumns?: Map<ColumnHint, string>) => {
  const columnsToHints: Map<string, ColumnHint> = new Map();
  if (hintsToColumns) {
    hintsToColumns.forEach((name, hint) => {
      columnsToHints.set(name.toLowerCase().trim(), hint);
    });
  }

  for (const column of columns) {
    if (column.hint) {
      continue;
    }

    const name = column.name.toLowerCase().trim();
    const alias = column.alias?.toLowerCase().trim() || '';

    const hint = columnsToHints.get(name) || columnsToHints.get(alias);
    if (hint) {
      column.hint = hint;
      continue;
    }

    if (name.includes('time')) {
      column.hint = ColumnHint.Time;
    }
  }
};

/**
 * Converts label into sql-style column name.
 * Example: "Test Column" -> "test_column"
 */
export const columnLabelToPlaceholder = (label: string) => label.toLowerCase().replace(/ /g, '_');

/**
 * Field config map for trace search result columns.
 * Maps column name (lowercase) to Grafana FieldConfig for better default display.
 */
const traceSearchFieldConfigs: Record<string, FieldConfig> = {
  duration: {
    unit: 'ns',
    displayName: 'Duration',
  },
  starttime: {
    displayName: 'Start Time',
  },
  servicename: {
    displayName: 'Service Name',
  },
  operationname: {
    displayName: 'Operation Name',
  },
  traceid: {
    displayName: 'Trace ID',
  },
  spanid: {
    displayName: 'Span ID',
  },
  parentspanid: {
    displayName: 'Parent Span ID',
  },
  statuscode: {
    displayName: 'Status Code',
  },
  statusmessage: {
    displayName: 'Status Message',
  },
  spankind: {
    displayName: 'Span Kind',
  },
  spanname: {
    displayName: 'Span Name',
  },
};

/**
 * Applies field configs to trace search result frames for better default display.
 * NOTE: Only applies to trace search results (non-traceIdMode).
 * Applying configs to log frames causes stack overflow in Grafana's deep-clone.
 */
export const applyTraceSearchFieldConfig = (req: DataQueryRequest<CHQuery>, res: DataQueryResponse): DataQueryResponse => {
  res.data.forEach((frame: DataFrame) => {
    const originalQuery = req.targets.find((t) => t.refId === frame.refId) as CHBuilderQuery;
    if (!originalQuery) {
      return;
    }

    const isTraceSearch = originalQuery.editorType === EditorType.Builder &&
      originalQuery.builderOptions.queryType === QueryType.Traces &&
      !originalQuery.builderOptions.meta?.isTraceIdMode;

    if (!isTraceSearch) {
      return;
    }

    frame.fields.forEach((field) => {
      const fieldConfig = traceSearchFieldConfigs[field.name.toLowerCase()];
      if (fieldConfig) {
        field.config = {
          ...field.config,
          ...fieldConfig,
        };
      }
    });
  });

  return res;
};

/**
 * T-NEW: Enriches response frames with Grafana metadata for optimal visualization.
 * Sets DataFrameType, preferredVisualisationType, executedQueryString, and query stats.
 * Also generates supplementary frames (status bar chart for traces, etc.)
 */
const enrichResponseMetadata = (
  req: DataQueryRequest<CHQuery>,
  res: DataQueryResponse
): DataQueryResponse => {
  res.data.forEach((frame: DataFrame) => {
    const originalQuery = req.targets.find((t) => t.refId === frame.refId) as CHBuilderQuery;
    if (!originalQuery) {
      return;
    }

    // Initialize meta if not present
    if (!frame.meta) {
      frame.meta = {};
    }

    // Skip if already enriched (prevent re-processing loops)
    if (frame.meta.custom?.enriched) {
      return;
    }

    // Show executed SQL in Query Inspector (T6.1 frontend part)
    if (originalQuery.rawSql && !frame.meta.executedQueryString) {
      frame.meta.executedQueryString = originalQuery.rawSql;
    }

    // Set preferredVisualisationType based on query type
    // NOTE: Do NOT set DataFrameType.LogLines — it causes infinite re-processing
    // The backend already handles log frame detection via the format field
    if (originalQuery.editorType === EditorType.Builder) {
      const queryType = originalQuery.builderOptions?.queryType;
      const isTraceIdMode = originalQuery.builderOptions?.meta?.isTraceIdMode;

      if (queryType === QueryType.Traces && isTraceIdMode) {
        frame.meta.preferredVisualisationType = 'trace';
      } else if (queryType === QueryType.TimeSeries) {
        frame.meta.preferredVisualisationType = 'graph';
      }
    }

    // Mark as enriched
    if (!frame.meta.custom) {
      frame.meta.custom = {};
    }
    frame.meta.custom.enriched = true;
  });

  return res;
};

/**
 * Generates a supplementary bar chart frame showing trace status breakdown.
 * Returned alongside trace search results in Explore to show error distribution.
 */
const generateTraceStatusFrame = (searchFrame: DataFrame, refId: string): DataFrame | null => {
  const statusField = searchFrame.fields.find(
    (f) => f.name.toLowerCase() === 'status' || f.name.toLowerCase() === 'statuscode'
  );
  if (!statusField || !statusField.values || statusField.values.length === 0) {
    return null;
  }

  // Count status occurrences
  const counts: Record<string, number> = {};
  for (let i = 0; i < statusField.values.length; i++) {
    const val = String(statusField.values[i] || 'OK');
    const label = val === 'STATUS_CODE_ERROR' ? 'Error' :
                  val === 'STATUS_CODE_OK' ? 'OK' :
                  val === 'STATUS_CODE_UNSET' ? 'Unset' :
                  val === '' ? 'OK' : val;
    counts[label] = (counts[label] || 0) + 1;
  }

  if (Object.keys(counts).length === 0) {
    return null;
  }

  const statusLabels = Object.keys(counts);
  const statusValues = Object.values(counts);

  const frame: DataFrame = {
    name: 'Trace Status',
    refId: `${refId}-status`,
    fields: [
      {
        name: 'Status',
        type: FieldType.string,
        values: statusLabels,
        config: {},
      },
      {
        name: 'Count',
        type: FieldType.number,
        values: statusValues,
        config: {
          color: {
            mode: 'fixed',
            fixedColor: 'green',
          },
        },
      },
    ],
    length: statusLabels.length,
    meta: {
      preferredVisualisationType: 'graph',
      custom: { resultType: 'status-breakdown' },
    },
  };

  // Color the error bar red
  const errorIdx = statusLabels.indexOf('Error');
  if (errorIdx >= 0) {
    frame.fields[1].config = {
      ...frame.fields[1].config,
      custom: {
        fillOpacity: 80,
      },
    };
  }

  return frame;
};

/**
 * Generates Node Graph frames (Nodes + Edges) from trace data for service map visualization.
 * This is T2.1 — service map via Node Graph panel.
 * Called when trace search results contain ServiceName data.
 */
export const generateServiceMapFrames = (
  traceSearchFrame: DataFrame,
  refId: string
): DataFrame[] => {
  const serviceField = traceSearchFrame.fields.find(
    (f) => f.name.toLowerCase() === 'servicename' || f.name.toLowerCase() === 'service'
  );
  const statusField = traceSearchFrame.fields.find(
    (f) => f.name.toLowerCase() === 'status' || f.name.toLowerCase() === 'statuscode'
  );
  const durationField = traceSearchFrame.fields.find(
    (f) => f.name.toLowerCase() === 'duration'
  );

  if (!serviceField || !serviceField.values || serviceField.values.length === 0) {
    return [];
  }

  // Aggregate per-service stats
  const serviceStats: Record<string, { count: number; errors: number; totalDuration: number }> = {};
  for (let i = 0; i < serviceField.values.length; i++) {
    const svc = String(serviceField.values[i] || 'unknown');
    if (!serviceStats[svc]) {
      serviceStats[svc] = { count: 0, errors: 0, totalDuration: 0 };
    }
    serviceStats[svc].count++;
    if (statusField?.values?.[i] === 'STATUS_CODE_ERROR' || statusField?.values?.[i] === 'Error') {
      serviceStats[svc].errors++;
    }
    if (durationField?.values?.[i]) {
      serviceStats[svc].totalDuration += Number(durationField.values[i]);
    }
  }

  const services = Object.keys(serviceStats);
  if (services.length === 0) {
    return [];
  }

  // Build Nodes frame
  const nodesFrame: DataFrame = {
    name: 'nodes',
    refId: `${refId}-nodes`,
    fields: [
      { name: NodeGraphDataFrameFieldNames.id, type: FieldType.string, values: services, config: {} },
      { name: NodeGraphDataFrameFieldNames.title, type: FieldType.string, values: services, config: {} },
      {
        name: NodeGraphDataFrameFieldNames.mainStat,
        type: FieldType.string,
        values: services.map((s) => `${serviceStats[s].count} req`),
        config: {},
      },
      {
        name: NodeGraphDataFrameFieldNames.secondaryStat,
        type: FieldType.string,
        values: services.map((s) => {
          const avg = serviceStats[s].totalDuration / serviceStats[s].count / 1000000;
          return `${avg.toFixed(1)} ms avg`;
        }),
        config: {},
      },
      {
        name: 'arc__success',
        type: FieldType.number,
        values: services.map((s) => {
          const stats = serviceStats[s];
          return stats.count > 0 ? (stats.count - stats.errors) / stats.count : 1;
        }),
        config: { color: { mode: 'fixed', fixedColor: 'green' } },
      },
      {
        name: 'arc__errors',
        type: FieldType.number,
        values: services.map((s) => {
          const stats = serviceStats[s];
          return stats.count > 0 ? stats.errors / stats.count : 0;
        }),
        config: { color: { mode: 'fixed', fixedColor: 'red' } },
      },
    ],
    length: services.length,
    meta: { preferredVisualisationType: 'nodeGraph' },
  };

  // For a basic service map we return just nodes (edges require peer.service attribute data)
  return [nodesFrame];
};

/**
 * Mutates the DataQueryResponse to include trace/log links on the traceID field.
 * The link will open a second query editor in split view
 * on the explore page with the selected trace ID.
 *
 * Requires defaults to be configured when crossing query types.
 */
export const transformQueryResponseWithTraceAndLogLinks = (
  datasource: Datasource,
  req: DataQueryRequest<CHQuery>,
  res: DataQueryResponse
): DataQueryResponse => {
  applyTraceSearchFieldConfig(req, res);
  // NOTE: enrichResponseMetadata disabled — was causing stack overflow in Grafana's
  // frame deep-clone logic. The metadata enrichment (preferredVisualisationType, etc.)
  // needs to be done differently, likely via the backend response metadata.
  // enrichResponseMetadata(req, res);

  res.data.forEach((frame: DataFrame) => {
    const originalQuery = req.targets.find((t) => t.refId === frame.refId) as CHBuilderQuery;
    if (!originalQuery) {
      return;
    }

    const traceField = frame.fields.find(
      (field) => field.name.toLowerCase() === 'traceid' || field.name.toLowerCase() === 'trace_id'
    );
    if (!traceField) {
      return;
    }

    // Get the configured TraceId column name for use in both trace and logs queries
    const defaultLogsColumns = datasource.getDefaultLogsColumns();
    // Use traces config traceIdColumn if available, otherwise fallback to logs default
    const traceIdColumnName = datasource.getTracesTraceIdColumn() || defaultLogsColumns.get(ColumnHint.TraceId) || 'TraceId';

    const dsRef = { uid: datasource.uid, type: datasource.type };
    const traceIdQuery: CHBuilderQuery = {
      datasource: dsRef,
      editorType: EditorType.Builder,
      /**
       * Evil bug:
       * The rawSql value might contain time filters such as $__fromTime and $__toTime.
       * Grafana sees these time range filters as data links and will refuse to enable the traceID link if these are present.
       * Set rawSql to empty since it gets regenerated when the panel renders anyway.
       */
      rawSql: '',
      builderOptions: {} as QueryBuilderOptions,
      pluginVersion,
      refId: 'Trace ID',
    };

    if (
      originalQuery.editorType === EditorType.Builder &&
      originalQuery.builderOptions.queryType === QueryType.Traces
    ) {
      // Copy fields directly from trace search

      traceIdQuery.builderOptions = {
        ...originalQuery.builderOptions,
        filters: [], // Clear filters and orderBy since it's an exact ID lookup
        orderBy: [],
        meta: {
          ...originalQuery.builderOptions.meta,
          minimized: true,
          isTraceIdMode: true,
          traceId: '${__value.raw}',
        },
      };
    } else {
      // Create new query based on trace defaults

      const otelVersion = datasource.getTraceOtelVersion();
      const otelConfig = otel.getVersion(otelVersion);
      const traceEventsColumnPrefix = datasource.getDefaultTraceEventsColumnPrefix();
      const traceLinksColumnPrefix = datasource.getDefaultTraceLinksColumnPrefix();
      const options: QueryBuilderOptions = {
        database:
          datasource.getDefaultTraceDatabase() ||
          traceIdQuery.builderOptions.database ||
          datasource.getDefaultDatabase(),
        table: datasource.getDefaultTraceTable() || datasource.getDefaultTable() || traceIdQuery.builderOptions.table,
        queryType: QueryType.Traces,
        columns: [],
        filters: [],
        orderBy: [],
        meta: {
          minimized: true,
          isTraceIdMode: true,
          traceId: '${__value.raw}',
          traceDurationUnit: datasource.getDefaultTraceDurationUnit(),
          otelEnabled: Boolean(otelVersion),
          otelVersion: otelVersion,
          traceEventsColumnPrefix: traceEventsColumnPrefix,
          traceLinksColumnPrefix: traceLinksColumnPrefix,
        },
      };

      if (otelConfig?.traceColumnMap) {
        options.columns = Array.from(otelConfig.traceColumnMap, ([hint, name]) => ({ name, hint }));
      } else {
        const defaultColumns = datasource.getDefaultTraceColumns();
        for (let [hint, colName] of defaultColumns) {
          options.columns!.push({ name: colName, hint });
        }
      }

      traceIdQuery.builderOptions = options;
    }

    const traceLogsQuery: CHBuilderQuery = {
      datasource: dsRef,
      editorType: EditorType.Builder,
      rawSql: '',
      builderOptions: {} as QueryBuilderOptions,
      pluginVersion,
      refId: 'Trace Logs',
    };

    if (originalQuery.editorType === EditorType.Builder && originalQuery.builderOptions.queryType === QueryType.Logs) {
      // Copy fields directly from log search
      traceLogsQuery.builderOptions = {
        ...originalQuery.builderOptions,
        filters: [
          {
            type: 'string',
            operator: FilterOperator.Equals,
            filterType: 'custom',
            key: traceIdColumnName,
            hint: ColumnHint.TraceId,
            condition: 'AND',
            value: '${__value.raw}',
          } as StringFilter,
        ],
        orderBy: [{ name: '', hint: ColumnHint.Time, dir: OrderByDirection.ASC }],
        meta: {
          ...originalQuery.builderOptions.meta,
          minimized: true,
        },
      };
    } else {
      // Create new query based on log defaults

      const otelVersion = datasource.getLogsOtelVersion();
      const options: QueryBuilderOptions = {
        database:
          datasource.getDefaultLogsDatabase() ||
          traceLogsQuery.builderOptions.database ||
          datasource.getDefaultDatabase(),
        table: datasource.getDefaultLogsTable() || datasource.getDefaultTable() || traceLogsQuery.builderOptions.table,
        queryType: QueryType.Logs,
        columns: [],
        orderBy: [{ name: '', hint: ColumnHint.Time, dir: OrderByDirection.ASC }],
        filters: [
          {
            type: 'string',
            operator: FilterOperator.Equals,
            filterType: 'custom',
            key: traceIdColumnName,
            hint: ColumnHint.TraceId,
            condition: 'AND',
            value: '${__value.raw}',
          } as StringFilter,
        ],
        meta: {
          minimized: true,
          otelEnabled: Boolean(otelVersion),
          otelVersion: otelVersion,
        },
      };

      for (let [hint, colName] of defaultLogsColumns) {
        options.columns!.push({ name: colName, hint });
      }

      // Ensure TraceId column is in the array so filter can find it via hint lookup
      if (!options.columns!.find((c) => c.hint === ColumnHint.TraceId)) {
        options.columns!.push({ name: traceIdColumnName, hint: ColumnHint.TraceId });
      }

      traceLogsQuery.builderOptions = options;
    }

    // Generate rawSql for Dashboard mode to preserve query through serialization
    const openInNewWindow = req.app !== CoreApp.Explore;
    if (openInNewWindow) {
      traceLogsQuery.rawSql = generateSql(traceLogsQuery.builderOptions || {});
    } else {
      traceLogsQuery.rawSql = '';
    }
    // JSON round-trip to strip circular references and class instances.
    // Grafana's L() deep-clone function recurses infinitely on non-plain objects.
    const safeClone = (obj: any) => JSON.parse(JSON.stringify(obj));

    traceField.config.links = [];
    if (datasource.settings.jsonData.traces?.showTraceLinks !== false) {
      traceField.config.links!.push({
        title: 'View trace',
        targetBlank: openInNewWindow,
        url: '',
        internal: {
          query: safeClone(traceIdQuery),
          datasourceUid: dsRef.uid!,
          datasourceName: dsRef.type!,
          panelsState: {
            trace: {
              spanId: '${__value.raw}',
            },
          },
        },
      });
    }
    if (datasource.settings.jsonData.logs?.showLogLinks !== false) {
      traceField.config.links!.push({
        title: 'View logs',
        targetBlank: openInNewWindow,
        url: '',
        internal: {
          query: safeClone(traceLogsQuery),
          datasourceUid: dsRef.uid!,
          datasourceName: dsRef.type!,
        },
      });
    }
  });

  // T2.1: Service map Node Graph frames disabled — was causing stack overflow
  // when Grafana deep-clones frames with plain array values fields.
  // TODO: Re-enable with proper Vector wrapper for field values.
  /*
  res.data.forEach((frame: DataFrame) => {
    const originalQuery = req.targets.find((t) => t.refId === frame.refId) as CHBuilderQuery;
    if (!originalQuery || originalQuery.editorType !== EditorType.Builder) {
      return;
    }
    if (
      originalQuery.builderOptions?.queryType === QueryType.Traces &&
      !originalQuery.builderOptions?.meta?.isTraceIdMode &&
      frame.fields.length > 0
    ) {
      const serviceMapFrames = generateServiceMapFrames(frame, originalQuery.refId || 'A');
      if (serviceMapFrames.length > 0) {
        res.data = [...res.data, ...serviceMapFrames];
      }
    }
  });
  */

  return res;
};

// The name of the dataframe field containing labels
export const labelsFieldName = 'labels';

/**
 * Returns true if the dataframe contains a log label that matches the provided name.
 *
 * This function exists for the logs panel, when clicking "filter for value" on a single log row.
 * A dataframe will be provided for that single row, and we need to check the labels object to see if it
 * contains a field with that name. If it does then we can create a filter using the labels column hint.
 */
export const dataFrameHasLogLabelWithName = (frame: DataFrame | undefined, name: string): boolean => {
  if (!frame || !frame.fields || frame.fields.length === 0) {
    return false;
  }

  const field = frame.fields.find((f) => f.name === labelsFieldName);
  if (!field || !field.values || field.values.length < 1 || !field.values.get(0)) {
    return false;
  }

  const labels = (field.values.get(0) || {}) as object;
  const labelKeys = Object.keys(labels);

  return labelKeys.includes(name);
};
