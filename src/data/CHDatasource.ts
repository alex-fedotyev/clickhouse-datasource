import {
  AbstractLabelOperator,
  AbstractQuery,
  AdHocVariableFilter,
  AnnotationSupport,
  DataFrame,
  DataFrameView,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  DataSourceWithLogsContextSupport,
  DataSourceWithLogsLabelTypesSupport,
  DataSourceWithQueryExportSupport,
  DataSourceWithQueryImportSupport,
  DataSourceWithQueryModificationSupport,
  DataSourceWithSupplementaryQueriesSupport,
  DataSourceWithToggleableQueryFiltersSupport,
  Field,
  getTimeZone,
  getTimeZoneInfo,
  LogRowContextOptions,
  LogRowContextQueryDirection,
  LogRowModel,
  MetricFindValue,
  QueryFilterOptions,
  QueryFixAction,
  QueryFixType,
  ScopedVars,
  SupplementaryQueryOptions,
  SupplementaryQueryType,
  ToggleFilterAction,
  TypedVariableModel,
} from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';
import LogsContextPanel from 'components/LogsContextPanel';
import { cloneDeep, isEmpty, isString } from 'lodash';
import otel from 'otel';
import { createElement as createReactElement, ReactNode } from 'react';
import { firstValueFrom, map, Observable } from 'rxjs';
import { CHConfig } from 'types/config';
import {
  AggregateColumn,
  AggregateType,
  BuilderMode,
  ColumnHint,
  Filter,
  FilterOperator,
  OrderByDirection,
  QueryBuilderOptions,
  QueryType,
  SelectedColumn,
  SqlFunction,
  TableColumn,
  TimeUnit,
} from 'types/queryBuilder';
import { CHQuery, EditorType } from 'types/sql';
import { pluginVersion } from 'utils/version';
import { AdHocFilter } from './adHocFilter';
import {
  DEFAULT_LOGS_ALIAS,
  getIntervalInfo,
  getTimeFieldRoundingClause,
  LOG_LEVEL_TO_IN_CLAUSE,
  splitLogsVolumeFrames,
  TIME_FIELD_ALIAS,
} from './logs';
import { generateSql, getColumnByHint, logAliasToColumnHints } from './sqlGenerator';
import { labelsFieldName, transformQueryResponseWithTraceAndLogLinks } from './utils';
import { CHVariableSupport } from './CHVariableSupport';

export class Datasource
  extends DataSourceWithBackend<CHQuery, CHConfig>
  implements
    DataSourceWithSupplementaryQueriesSupport<CHQuery>,
    DataSourceWithLogsContextSupport<CHQuery>,
    DataSourceWithQueryModificationSupport<CHQuery>,
    DataSourceWithToggleableQueryFiltersSupport<CHQuery>,
    DataSourceWithQueryImportSupport<CHQuery>,
    DataSourceWithQueryExportSupport<CHQuery>,
    DataSourceWithLogsLabelTypesSupport
{
  // T1.6: AnnotationSupport with migration and default query
  annotations: AnnotationSupport<CHQuery> = {
    prepareAnnotation: (json: any) => {
      // Migrate old string-based annotation queries to CHQuery format
      if (json?.rawQuery && !json?.target?.rawSql) {
        return {
          ...json,
          target: {
            editorType: EditorType.SQL,
            rawSql: json.rawQuery,
            refId: 'annotation',
          },
        };
      }
      return json;
    },
    getDefaultQuery: (): Partial<CHQuery> => {
      return {
        editorType: EditorType.SQL,
        rawSql: [
          'SELECT',
          '  Timestamp AS time,',
          '  Body AS text,',
          "  SeverityText AS tags,",
          "  ServiceName AS title",
          'FROM otel_logs',
          'WHERE $__timeFilter(Timestamp)',
          "  AND SeverityText IN ('ERROR', 'FATAL')",
          'ORDER BY Timestamp',
          'LIMIT 100',
        ].join('\n'),
        refId: 'annotation',
      };
    },
  };
  settings: DataSourceInstanceSettings<CHConfig>;
  adHocFilter: AdHocFilter;
  skipAdHocFilter = false; // don't apply adhoc filters to the query
  adHocFiltersStatus = AdHocFilterStatus.none; // ad hoc filters only work with CH 22.7+
  adHocCHVerReq = { major: 22, minor: 7 };

  constructor(instanceSettings: DataSourceInstanceSettings<CHConfig>) {
    super(instanceSettings);
    this.settings = instanceSettings;
    this.adHocFilter = new AdHocFilter();
    this.variables = new CHVariableSupport(this);
  }

  static logVolumePrefix = 'log-volume-';
  static logsSamplePrefix = 'logs-sample-';

  getSupplementaryRequest(
    type: SupplementaryQueryType,
    request: DataQueryRequest<CHQuery>
  ): DataQueryRequest<CHQuery> | undefined {
    if (!this.getSupportedSupplementaryQueryTypes(request).includes(type)) {
      return undefined;
    }

    if (type === SupplementaryQueryType.LogsVolume) {
      const logsVolumeRequest = cloneDeep(request);

      const intervalInfo = getIntervalInfo(logsVolumeRequest.scopedVars);
      logsVolumeRequest.interval = intervalInfo.interval;
      logsVolumeRequest.scopedVars.__interval = { value: intervalInfo.interval, text: intervalInfo.interval };
      logsVolumeRequest.hideFromInspector = true;
      if (intervalInfo.intervalMs !== undefined) {
        logsVolumeRequest.intervalMs = intervalInfo.intervalMs;
        logsVolumeRequest.scopedVars.__interval_ms = {
          value: intervalInfo.intervalMs,
          text: intervalInfo.intervalMs,
        };
      }

      const targets: CHQuery[] = [];
      logsVolumeRequest.targets.forEach((target) => {
        const supplementaryQuery = this.getSupplementaryLogsVolumeQuery(logsVolumeRequest, target);
        if (supplementaryQuery !== undefined) {
          targets.push({ ...supplementaryQuery, refId: `${Datasource.logVolumePrefix}${target.refId}` });
        }
      });

      if (!targets.length) {
        return undefined;
      }

      return { ...logsVolumeRequest, targets };
    }

    if (type === SupplementaryQueryType.LogsSample) {
      const logsSampleRequest = cloneDeep(request);
      logsSampleRequest.hideFromInspector = true;

      const targets: CHQuery[] = [];
      logsSampleRequest.targets.forEach((target) => {
        const supplementaryQuery = this.getSupplementaryLogsSampleQuery(target);
        if (supplementaryQuery !== undefined) {
          targets.push({ ...supplementaryQuery, refId: `${Datasource.logsSamplePrefix}${target.refId}` });
        }
      });

      if (!targets.length) {
        return undefined;
      }

      return { ...logsSampleRequest, targets };
    }

    return undefined;
  }

  getSupportedSupplementaryQueryTypes(dsRequest?: DataQueryRequest<CHQuery>): SupplementaryQueryType[] {
    // T3.3: Support supplementary queries for SQL mode when OTEL is configured
    if (dsRequest && dsRequest.targets.some((t) => t.editorType !== EditorType.Builder)) {
      // Even in SQL mode, if OTEL is configured we can generate volume histograms
      const logsOtelVersion = this.getLogsOtelVersion();
      if (logsOtelVersion && this.getDefaultLogsTable()) {
        return [SupplementaryQueryType.LogsVolume];
      }
      return [];
    }
    return [SupplementaryQueryType.LogsVolume, SupplementaryQueryType.LogsSample];
  }

  getSupplementaryLogsVolumeQuery(logsVolumeRequest: DataQueryRequest<CHQuery>, query: CHQuery): CHQuery | undefined {
    if (
      query.editorType !== EditorType.Builder ||
      query.builderOptions.queryType !== QueryType.Logs ||
      query.builderOptions.mode !== BuilderMode.List ||
      query.builderOptions.database === '' ||
      query.builderOptions.table === ''
    ) {
      return undefined;
    }

    const timeColumn = getColumnByHint(query.builderOptions, ColumnHint.FilterTime) || getColumnByHint(query.builderOptions, ColumnHint.Time);
    if (timeColumn === undefined) {
      return undefined;
    }

    const columns: SelectedColumn[] = [];
    const aggregates: AggregateColumn[] = [];
    columns.push({
      name: getTimeFieldRoundingClause(logsVolumeRequest.scopedVars, timeColumn.name),
      alias: TIME_FIELD_ALIAS,
      hint: timeColumn.hint!,
    });

    const logLevelColumn = getColumnByHint(query.builderOptions, ColumnHint.LogLevel);
    if (logLevelColumn) {
      // Generates aggregates like
      // sum(toString("log_level") IN ('dbug', 'debug', 'DBUG', 'DEBUG', 'Dbug', 'Debug')) AS debug
      const llf = `toString("${logLevelColumn.name}")`;
      let level: keyof typeof LOG_LEVEL_TO_IN_CLAUSE;
      for (level in LOG_LEVEL_TO_IN_CLAUSE) {
        aggregates.push({
          aggregateType: AggregateType.Sum,
          column: `multiSearchAny(${llf}, [${LOG_LEVEL_TO_IN_CLAUSE[level]}])`,
          alias: level,
        });
      }
    } else {
      // Count all logs if level column isn't selected
      aggregates.push({
        aggregateType: AggregateType.Count,
        column: '*',
        alias: DEFAULT_LOGS_ALIAS,
      });
    }

    const filters = (query.builderOptions.filters?.slice() || []).map((f) => {
      // In order for a hinted filter to work, the hinted column must be SELECTed OR provide "key"
      // For this histogram query the "level" column isn't selected, so we must find the original column name
      if (f.hint && !f.key) {
        const originalColumn = getColumnByHint(query.builderOptions, f.hint);
        f.key = originalColumn?.alias || originalColumn?.name || '';
      }

      return f;
    });

    const logVolumeSqlBuilderOptions: QueryBuilderOptions = {
      database: query.builderOptions.database,
      table: query.builderOptions.table,
      queryType: QueryType.TimeSeries,
      filters,
      columns,
      aggregates,
      orderBy: [{ name: '', hint: timeColumn.hint!, dir: OrderByDirection.ASC }],
    };

    const logVolumeSupplementaryQuery = generateSql(logVolumeSqlBuilderOptions);
    return {
      pluginVersion,
      editorType: EditorType.Builder,
      builderOptions: logVolumeSqlBuilderOptions,
      rawSql: logVolumeSupplementaryQuery,
      refId: '',
    };
  }

  getSupplementaryLogsSampleQuery(query: CHQuery): CHQuery | undefined {
    if (
      query.editorType !== EditorType.Builder ||
      !query.builderOptions.database ||
      query.builderOptions.table !== this.getDefaultLogsTable()
    ) {
      return undefined;
    }

    const timeColumn =
      getColumnByHint(query.builderOptions, ColumnHint.FilterTime) ||
      getColumnByHint(query.builderOptions, ColumnHint.Time);

    if (!timeColumn) {
      return undefined;
    }

    const timeHint = timeColumn.hint ?? ColumnHint.Time;

    const filters = (query.builderOptions.filters?.slice() || []).map((f) => {
      if (f.hint && !f.key) {
        const originalColumn = getColumnByHint(query.builderOptions, f.hint);
        f.key = originalColumn?.alias || originalColumn?.name || '';
      }
      return { ...f };
    });

    const defaultColumns = Array.from(this.getDefaultLogsColumns(), ([hint, name]) => ({ hint, name }));

    const columns = defaultColumns.length
      ? defaultColumns
      : (query.builderOptions.columns ?? [{ name: timeColumn.name, hint: timeHint }]);


    const logsSampleBuilderOptions: QueryBuilderOptions = {
      database: query.builderOptions.database,
      table: query.builderOptions.table,
      queryType: QueryType.Logs,
      mode: BuilderMode.List,
      filters,
      columns,
      orderBy: [{ name: '', hint: timeHint, dir: OrderByDirection.DESC }],
      limit: 100,
    };

    return {
      pluginVersion,
      editorType: EditorType.Builder,
      builderOptions: logsSampleBuilderOptions,
      rawSql: generateSql(logsSampleBuilderOptions),
      refId: '',
      format: 2, // Logs format
    };
  }

  /**
   * T1.5: Returns a supplementary query for Grafana to manage.
   * Replaces the deprecated getDataProvider() Observable pipeline with the modern
   * getSupplementaryQuery() approach where Grafana manages the query lifecycle.
   * Also adds LogsSample support (T3.1) — when running an aggregation query on logs,
   * returns sample log lines matching the same filters.
   */
  getSupplementaryQuery(options: SupplementaryQueryOptions, originalQuery: CHQuery): CHQuery | undefined {
    if (options.type === SupplementaryQueryType.LogsVolume) {
      return this._getLogsVolumeSupplementaryQuery(originalQuery);
    }

    if (options.type === SupplementaryQueryType.LogsSample) {
      return this._getLogsSampleSupplementaryQuery(originalQuery);
    }

    return undefined;
  }

  /**
   * T1.5: Generates a logs volume supplementary query from the original log query.
   * This replaces the custom Observable pipeline in getDataProvider() with a query object
   * that Grafana manages directly.
   */
  private _getLogsVolumeSupplementaryQuery(query: CHQuery): CHQuery | undefined {
    // T3.3: For SQL mode queries, generate volume from OTEL config if available
    if (query.editorType === EditorType.SQL || !query.builderOptions) {
      return this._getLogsVolumeFromOtelConfig(query);
    }

    if (
      query.builderOptions.queryType !== QueryType.Logs ||
      query.builderOptions.mode !== BuilderMode.List ||
      query.builderOptions.database === '' ||
      query.builderOptions.table === ''
    ) {
      return undefined;
    }

    const timeColumn = getColumnByHint(query.builderOptions, ColumnHint.FilterTime) || getColumnByHint(query.builderOptions, ColumnHint.Time);
    if (timeColumn === undefined) {
      return undefined;
    }

    const columns: SelectedColumn[] = [];
    const aggregates: AggregateColumn[] = [];
    columns.push({
      name: timeColumn.name,
      alias: TIME_FIELD_ALIAS,
      hint: timeColumn.hint!,
    });

    const logLevelColumn = getColumnByHint(query.builderOptions, ColumnHint.LogLevel);
    if (logLevelColumn) {
      const llf = `toString("${logLevelColumn.name}")`;
      let level: keyof typeof LOG_LEVEL_TO_IN_CLAUSE;
      for (level in LOG_LEVEL_TO_IN_CLAUSE) {
        aggregates.push({
          aggregateType: AggregateType.Sum,
          column: `multiSearchAny(${llf}, [${LOG_LEVEL_TO_IN_CLAUSE[level]}])`,
          alias: level,
        });
      }
    } else {
      aggregates.push({
        aggregateType: AggregateType.Count,
        column: '*',
        alias: DEFAULT_LOGS_ALIAS,
      });
    }

    const filters = (query.builderOptions.filters?.slice() || []).map((f) => {
      if (f.hint && !f.key) {
        const originalColumn = getColumnByHint(query.builderOptions, f.hint);
        f.key = originalColumn?.alias || originalColumn?.name || '';
      }
      return f;
    });

    const logVolumeSqlBuilderOptions: QueryBuilderOptions = {
      database: query.builderOptions.database,
      table: query.builderOptions.table,
      queryType: QueryType.TimeSeries,
      filters,
      columns,
      aggregates,
      orderBy: [{ name: '', hint: timeColumn.hint!, dir: OrderByDirection.ASC }],
    };

    return {
      pluginVersion,
      editorType: EditorType.Builder,
      builderOptions: logVolumeSqlBuilderOptions,
      rawSql: generateSql(logVolumeSqlBuilderOptions),
      refId: `${query.refId}-volume`,
      hide: true,
    };
  }

  /**
   * T3.1: Generates a LogsSample supplementary query.
   * When running an aggregation query on logs (count errors by service),
   * this returns sample log lines matching the same filters.
   */
  private _getLogsSampleSupplementaryQuery(query: CHQuery): CHQuery | undefined {
    if (
      query.editorType !== EditorType.Builder ||
      query.builderOptions.queryType !== QueryType.Logs ||
      query.builderOptions.mode !== BuilderMode.Aggregate ||
      query.builderOptions.database === '' ||
      query.builderOptions.table === ''
    ) {
      return undefined;
    }

    const timeColumn = getColumnByHint(query.builderOptions, ColumnHint.Time) || getColumnByHint(query.builderOptions, ColumnHint.FilterTime);
    if (!timeColumn) {
      return undefined;
    }

    // Strip aggregation and GROUP BY, keep WHERE filters, add ORDER BY + LIMIT
    const sampleBuilderOptions: QueryBuilderOptions = {
      database: query.builderOptions.database,
      table: query.builderOptions.table,
      queryType: QueryType.Logs,
      mode: BuilderMode.List,
      columns: query.builderOptions.columns?.filter(c => !c.hint || c.hint !== ColumnHint.FilterTime) || [],
      filters: query.builderOptions.filters?.slice() || [],
      orderBy: [{ name: '', hint: timeColumn.hint!, dir: OrderByDirection.DESC }],
      limit: 10,
    };

    return {
      pluginVersion,
      editorType: EditorType.Builder,
      builderOptions: sampleBuilderOptions,
      rawSql: generateSql(sampleBuilderOptions),
      refId: `${query.refId}-sample`,
      hide: true,
    };
  }

  /**
   * T3.3: Generate a logs volume query from OTEL config for SQL mode queries.
   * This enables the log volume histogram even when users write raw SQL.
   */
  private _getLogsVolumeFromOtelConfig(query: CHQuery): CHQuery | undefined {
    const logsOtelVersion = this.getLogsOtelVersion();
    const otelConfig = logsOtelVersion ? otel.getVersion(logsOtelVersion) : undefined;
    if (!otelConfig) {
      return undefined;
    }

    const database = this.getDefaultLogsDatabase() || this.getDefaultDatabase();
    const table = this.getDefaultLogsTable();
    if (!table) {
      return undefined;
    }

    const timeColumnName = otelConfig.logColumnMap.get(ColumnHint.FilterTime) || otelConfig.logColumnMap.get(ColumnHint.Time);
    const levelColumnName = otelConfig.logColumnMap.get(ColumnHint.LogLevel);
    if (!timeColumnName) {
      return undefined;
    }

    const columns: SelectedColumn[] = [{
      name: timeColumnName,
      alias: TIME_FIELD_ALIAS,
      hint: ColumnHint.FilterTime,
    }];

    const aggregates: AggregateColumn[] = [];
    if (levelColumnName) {
      const llf = `toString("${levelColumnName}")`;
      let level: keyof typeof LOG_LEVEL_TO_IN_CLAUSE;
      for (level in LOG_LEVEL_TO_IN_CLAUSE) {
        aggregates.push({
          aggregateType: AggregateType.Sum,
          column: `multiSearchAny(${llf}, [${LOG_LEVEL_TO_IN_CLAUSE[level]}])`,
          alias: level,
        });
      }
    } else {
      aggregates.push({ aggregateType: AggregateType.Count, column: '*', alias: DEFAULT_LOGS_ALIAS });
    }

    const builderOptions: QueryBuilderOptions = {
      database,
      table,
      queryType: QueryType.TimeSeries,
      filters: [{
        operator: FilterOperator.WithInGrafanaTimeRange,
        filterType: 'custom',
        hint: ColumnHint.FilterTime,
        key: '',
        type: 'datetime',
        condition: 'AND',
      }],
      columns,
      aggregates,
      orderBy: [{ name: '', hint: ColumnHint.FilterTime, dir: OrderByDirection.ASC }],
    };

    return {
      pluginVersion,
      editorType: EditorType.Builder,
      builderOptions,
      rawSql: generateSql(builderOptions),
      refId: `${query.refId}-volume`,
      hide: true,
    };
  }

  async metricFindQuery(query: CHQuery | string, options: any) {
    if (this.adHocFiltersStatus === AdHocFilterStatus.none) {
      this.adHocFiltersStatus = await this.canUseAdhocFilters();
    }
    const chQuery = isString(query) ? { rawSql: query, editorType: EditorType.SQL } : query;

    if (!(chQuery.editorType === EditorType.SQL || chQuery.editorType === EditorType.Builder || !chQuery.editorType)) {
      return [];
    }

    if (!chQuery.rawSql) {
      return [];
    }
    const frame = await this.runQuery(chQuery, options);
    if (frame.fields?.length === 0) {
      return [];
    }
    if (frame?.fields?.length === 1) {
      return frame?.fields[0]?.values.map((text) => ({ text, value: text }));
    }
    // convention - assume the first field is an id field
    const ids = frame?.fields[0]?.values;
    return frame?.fields[1]?.values.map((text, i) => ({ text, value: ids.get(i) }));
  }

  applyTemplateVariables(query: CHQuery, scoped: ScopedVars, filters: AdHocVariableFilter[] = []): CHQuery {
    let rawQuery = query.rawSql || '';
    const templateSrv = getTemplateSrv();
    const templateSrvVariables = templateSrv.getVariables() || [];

    // resolve template variables
    rawQuery = this.applyConditionalAll(rawQuery, templateSrvVariables);
    rawQuery = this.replace(rawQuery, scoped) || '';

    if (!this.skipAdHocFilter) {
      if (this.adHocFiltersStatus === AdHocFilterStatus.disabled && filters.length > 0) {
        throw new Error(
          `Unable to apply ad hoc filters. Upgrade ClickHouse to >=${this.adHocCHVerReq.major}.${this.adHocCHVerReq.minor} or remove ad hoc filters for the dashboard.`
        );
      }

      const useJSON = Boolean(templateSrvVariables.find(v => v.name === 'clickhouse_adhoc_use_json'));

      // Check if query contains $__adHocFilters macro
      const hasMacro = /\$__adHocFilters\s*\(\s*['"](.+?)['"]\s*\)/.test(rawQuery);

      // Apply $__adHocFilters macro before automatic filter application
      rawQuery = this.applyAdHocFiltersMacro(rawQuery, filters, useJSON);

      // Only apply automatic filters if the macro was not used
      if (!hasMacro) {
        rawQuery = this.adHocFilter.apply(rawQuery, filters, useJSON);
      }
    }
    this.skipAdHocFilter = false;

    return {
      ...query,
      rawSql: rawQuery,
    };
  }

  applyConditionalAll(rawQuery: string, templateVars: TypedVariableModel[]): string {
    if (!rawQuery) {
      return rawQuery;
    }
    const macro = '$__conditionalAll(';
    let macroIndex = rawQuery.lastIndexOf(macro);

    while (macroIndex !== -1) {
      const params = this.getMacroArgs(rawQuery, macroIndex + macro.length - 1);
      if (params.length !== 2) {
        return rawQuery;
      }
      const templateVarParam = params[1].trim();
      const varRegex = new RegExp(/(?<=\$\{)[\w\d]+(?=\})|(?<=\$)[\w\d]+/);
      const templateVar = varRegex.exec(templateVarParam);
      let phrase = params[0];
      if (templateVar) {
        const key = templateVars.find((x) => x.name === templateVar[0]) as any;
        let value = key?.current.value.toString();
        if (value === '' || value === '$__all') {
          phrase = '1=1';
        }
      }
      rawQuery = rawQuery.replace(`${macro}${params[0]},${params[1]})`, phrase);
      macroIndex = rawQuery.lastIndexOf(macro);
    }
    return rawQuery;
  }

  applyAdHocFiltersMacro(rawQuery: string, filters: AdHocVariableFilter[], useJSON = false): string {
    if (!rawQuery) {
      return rawQuery;
    }

    // Match $__adHocFilters('table_name') or $__adHocFilters("table_name")
    const regex = /\$__adHocFilters\s*\(\s*['"](.+?)['"]\s*\)/g;

    return rawQuery.replace(regex, (match, tableName) => {
      const filterStr = this.adHocFilter.buildFilterString(filters, useJSON);
      if (filterStr === '') {
        return 'additional_table_filters={}';
      }
      return `additional_table_filters={'${tableName}': '${filterStr}'}`;
    });
  }

  getSupportedQueryModifications() {
    return ['ADD_FILTER', 'ADD_FILTER_OUT', 'ADD_STRING_FILTER', 'ADD_STRING_FILTER_OUT']
  }

  // Support filtering by field value in Explore
  modifyQuery(query: CHQuery, action: QueryFixAction): CHQuery {
    // Handle string filters (text selection in Explore logs body)
    if (action.type === 'ADD_STRING_FILTER' || action.type === 'ADD_STRING_FILTER_OUT') {
      return this._modifyQueryWithStringFilter(query, action);
    }

    if (query.editorType !== EditorType.Builder || !action.options || !action.options.key || !action.options.value) {
      return query;
    }

    
    let columnName = (() => {
      const isStringFilterAction = action.type === 'ADD_STRING_FILTER' || action.type === 'ADD_STRING_FILTER_OUT';

      if (isStringFilterAction) {
        // has no key — resolve the column name from the log message hint.
        const logMessageColumn = getColumnByHint(query.builderOptions, ColumnHint.LogMessage);
        return logMessageColumn?.alias || logMessageColumn?.name || action.options.key || ''
      }

      return action.options.key || ''
    })()

    if (!columnName) {
      return query
    }

    const actionValue = action.options.value;
    let mapKey = '';

    // Convert flattened/merged OTel attributes into column+path pair
    if (['ResourceAttributes', 'ScopeAttributes', 'LogAttributes'].includes(columnName.split('.')[0])) {
      const prefixIndex = columnName.indexOf('.');
      mapKey = columnName.substring(prefixIndex + 1);
      columnName = columnName.substring(0, prefixIndex);
    }

    // Find selected column by alias/name
    const lookupByAlias = query.builderOptions.columns?.find((c) => c.alias === columnName); // Check all aliases first,
    const lookupByName = query.builderOptions.columns?.find((c) => c.name === columnName); // then try matching column name
    const lookupByLogsAlias = logAliasToColumnHints.has(columnName)
      ? getColumnByHint(query.builderOptions, logAliasToColumnHints.get(columnName)!)
      : undefined;
    const column = lookupByAlias || lookupByName || lookupByLogsAlias;
    const columnType = column ? column.type || '' : '';
    const hasMapKey = mapKey !== '';

    let nextFilters: Filter[] = query.builderOptions.filters?.slice() || [];
    if (action.type === 'ADD_FILTER') {
      // we need to remove *any other EQ or NE* for the same field,
      // because we don't want to end up with two filters like `level=info` AND `level=error`
      nextFilters = nextFilters.filter(
        (f) =>
          !(
            f.type === 'string' &&
            (column && column.hint && f.hint ? f.hint === column.hint : f.key === columnName) &&
            (f.operator === FilterOperator.IsAnything ||
              f.operator === FilterOperator.Equals ||
              f.operator === FilterOperator.NotEquals)
          ) &&
          !(
            (f.type.startsWith('Map') || f.type.startsWith('JSON')) &&
            column &&
            hasMapKey &&
            f.mapKey === mapKey &&
            (f.operator === FilterOperator.IsAnything ||
              f.operator === FilterOperator.Equals ||
              f.operator === FilterOperator.NotEquals)
          )
      );

      nextFilters.push({
        condition: 'AND',
        key: column && column.hint ? '' : columnName,
        hint: column && column.hint ? column.hint : undefined,
        mapKey: hasMapKey ? mapKey : undefined,
        type: hasMapKey ? (columnType.startsWith('Map') || columnType === '' ? 'Map(String, String)' : columnType) : 'String',
        filterType: 'custom',
        operator: FilterOperator.Equals,
        value: actionValue,
      });
    } else if (action.type === 'ADD_FILTER_OUT') {
      // with this we might want to add multiple values as NE filters
      // for example, `level != info` AND `level != debug`
      // thus, here we remove only exactly matching NE filters or an existing EQ filter for this field
      nextFilters = nextFilters.filter(
        (f) =>
          !(
            (f.type === 'string' &&
              (column && column.hint && f.hint ? f.hint === column.hint : f.key === columnName) &&
              'value' in f &&
              f.value === actionValue &&
              (f.operator === FilterOperator.IsAnything || f.operator === FilterOperator.NotEquals)) ||
            (f.type === 'string' &&
              (column && column.hint && f.hint ? f.hint === column.hint : f.key === columnName) &&
              (f.operator === FilterOperator.IsAnything || f.operator === FilterOperator.Equals)) ||
            ((f.type.startsWith('Map') || f.type.startsWith('JSON')) &&
              column &&
              hasMapKey &&
              f.mapKey === mapKey &&
              (f.operator === FilterOperator.IsAnything || f.operator === FilterOperator.Equals))
          )
      );

      nextFilters.push({
        condition: 'AND',
        key: column && column.hint ? '' : columnName,
        hint: column && column.hint ? column.hint : undefined,
        mapKey: hasMapKey ? mapKey : undefined,
        type: hasMapKey ? (columnType.startsWith('Map') || columnType === '' ? 'Map(String, String)' : columnType) : 'String',
        filterType: 'custom',
        operator: FilterOperator.NotEquals,
        value: actionValue,
      });
    } else if (action.type === 'ADD_STRING_FILTER') {
      nextFilters.push({
        condition: 'AND',
        key: columnName,
        filterType: 'custom',
        type: 'string',
        operator: FilterOperator.ILike,
        value: actionValue,
      });
    } else if (action.type === 'ADD_STRING_FILTER_OUT') {
      nextFilters.push({
        condition: 'AND',
        key: columnName,
        filterType: 'custom',
        type: 'string',
        operator: FilterOperator.NotILike,
        value: actionValue,
      });
    }

    // the query is updated to trigger the URL update and propagation to the panels
    const nextOptions = { ...query.builderOptions, filters: nextFilters };
    return {
      ...query,
      rawSql: generateSql(nextOptions),
      builderOptions: nextOptions,
    };
  }

  /**
   * T1.1: Returns the list of query modification actions this datasource supports.
   * Enables text selection filtering in Explore logs (select text → "Filter for value" / "Filter out value").
   */
  getSupportedQueryModifications(): QueryFixType[] {
    return ['ADD_FILTER', 'ADD_FILTER_OUT', 'ADD_STRING_FILTER', 'ADD_STRING_FILTER_OUT'];
  }

  /**
   * T1.1: Handles ADD_STRING_FILTER / ADD_STRING_FILTER_OUT from text selection in Explore logs.
   * Adds a LIKE/NOT LIKE filter on the log body column for the selected text.
   */
  private _modifyQueryWithStringFilter(query: CHQuery, action: QueryFixAction): CHQuery {
    if (query.editorType !== EditorType.Builder) {
      return query;
    }

    const searchText = action.options?.value || '';
    if (!searchText) {
      return query;
    }

    // Find the log message column
    const bodyColumn = getColumnByHint(query.builderOptions, ColumnHint.LogMessage);
    const columnName = bodyColumn?.name || 'Body';

    const isExclude = action.type === 'ADD_STRING_FILTER_OUT';
    const nextFilters: Filter[] = query.builderOptions.filters?.slice() || [];

    nextFilters.push({
      condition: 'AND',
      key: bodyColumn?.hint ? '' : columnName,
      hint: bodyColumn?.hint,
      type: 'String',
      filterType: 'custom',
      operator: isExclude ? FilterOperator.NotLike : FilterOperator.Like,
      value: `%${searchText}%`,
    });

    const nextOptions = { ...query.builderOptions, filters: nextFilters };
    return {
      ...query,
      rawSql: generateSql(nextOptions),
      builderOptions: nextOptions,
    };
  }

  /**
   * T1.2: Toggles a filter on/off in the query.
   * If the filter is already present with the same value, removes it.
   * If the opposite filter is present, replaces it.
   */
  toggleQueryFilter(query: CHQuery, filter: ToggleFilterAction): CHQuery {
    if (query.editorType !== EditorType.Builder) {
      return query;
    }

    const { key, value } = filter.options;
    const isFilterOut = filter.type === 'FILTER_OUT';
    const targetOperator = isFilterOut ? FilterOperator.NotEquals : FilterOperator.Equals;
    const oppositeOperator = isFilterOut ? FilterOperator.Equals : FilterOperator.NotEquals;

    let nextFilters: Filter[] = query.builderOptions.filters?.slice() || [];

    // Check if this exact filter already exists → remove it (toggle off)
    const existingIndex = nextFilters.findIndex(
      (f) => f.key === key && 'value' in f && f.value === value && f.operator === targetOperator
    );
    if (existingIndex >= 0) {
      nextFilters.splice(existingIndex, 1);
    } else {
      // Remove opposite filter if present, then add the new one
      nextFilters = nextFilters.filter(
        (f) => !(f.key === key && 'value' in f && f.value === value && f.operator === oppositeOperator)
      );

      // Also resolve column hints from OTel attribute names
      let columnName = key;
      let mapKey = '';
      if (['ResourceAttributes', 'ScopeAttributes', 'LogAttributes'].includes(key.split('.')[0])) {
        const prefixIndex = key.indexOf('.');
        mapKey = key.substring(prefixIndex + 1);
        columnName = key.substring(0, prefixIndex);
      }

      const lookupByName = query.builderOptions.columns?.find((c) => c.name === columnName);
      const lookupByLogsAlias = logAliasToColumnHints.has(key)
        ? getColumnByHint(query.builderOptions, logAliasToColumnHints.get(key)!)
        : undefined;
      const column = lookupByName || lookupByLogsAlias;
      const columnType = column ? column.type || '' : '';
      const hasMapKey = mapKey !== '';

      nextFilters.push({
        condition: 'AND',
        key: column && column.hint ? '' : (hasMapKey ? columnName : key),
        hint: column && column.hint ? column.hint : undefined,
        mapKey: hasMapKey ? mapKey : undefined,
        type: hasMapKey ? (columnType.startsWith('Map') || columnType === '' ? 'Map(String, String)' : columnType) : 'String',
        filterType: 'custom',
        operator: targetOperator,
        value,
      });
    }

    const nextOptions = { ...query.builderOptions, filters: nextFilters };
    return {
      ...query,
      rawSql: generateSql(nextOptions),
      builderOptions: nextOptions,
    };
  }

  /**
   * T1.2: Checks if a query already has a specific filter applied.
   * Used by Grafana to show active filter indicators (+/- buttons) in log details.
   */
  queryHasFilter(query: CHQuery, filter: QueryFilterOptions): boolean {
    if (query.editorType !== EditorType.Builder || !query.builderOptions.filters) {
      return false;
    }

    const { key, value } = filter;
    return query.builderOptions.filters.some(
      (f) =>
        ((f.key === key) || (f.hint && logAliasToColumnHints.has(key) && f.hint === logAliasToColumnHints.get(key))) &&
        'value' in f &&
        f.value === value &&
        (f.operator === FilterOperator.Equals || f.operator === FilterOperator.NotEquals)
    );
  }

  /**
   * T1.3: Returns the display type/category for a label in the logs detail panel.
   * Groups fields into "Resource Attributes", "Log Attributes", "Scope Attributes", etc.
   * instead of showing a flat list.
   */
  getLabelDisplayTypeFromFrame(labelKey: string, _frame: DataFrame | undefined, _index: number | null): string | null {
    // Map OTEL attribute prefixes to display categories
    if (labelKey.startsWith('ResourceAttributes.') || labelKey.startsWith('resource.')) {
      return 'Resource Attributes';
    }
    if (labelKey.startsWith('LogAttributes.') || labelKey.startsWith('log.')) {
      return 'Log Attributes';
    }
    if (labelKey.startsWith('ScopeAttributes.') || labelKey.startsWith('scope.')) {
      return 'Scope Attributes';
    }
    if (labelKey.startsWith('SpanAttributes.') || labelKey.startsWith('span.')) {
      return 'Span Attributes';
    }

    // Recognize well-known OTEL fields
    const otelCoreFields = ['TraceId', 'SpanId', 'TraceFlags', 'SeverityText', 'SeverityNumber', 'Body', 'ServiceName'];
    if (otelCoreFields.includes(labelKey)) {
      return 'Indexed Columns';
    }

    return null;
  }

  /**
   * T1.8: Import queries from other datasources (Loki, Elasticsearch, Prometheus).
   * When switching from another datasource to ClickHouse in Explore, filters are preserved.
   * E.g., Loki {service="web"} → ClickHouse WHERE ServiceName = 'web'
   */
  async importFromAbstractQueries(abstractQueries: AbstractQuery[]): Promise<CHQuery[]> {
    const logsOtelVersion = this.getLogsOtelVersion();
    const otelConfig = logsOtelVersion ? otel.getVersion(logsOtelVersion) : undefined;

    return abstractQueries.map((abstractQuery) => {
      const filters: Filter[] = abstractQuery.labelMatchers.map((matcher) => {
        let operator: FilterOperator;
        switch (matcher.operator) {
          case AbstractLabelOperator.Equal:
            operator = FilterOperator.Equals;
            break;
          case AbstractLabelOperator.NotEqual:
            operator = FilterOperator.NotEquals;
            break;
          case AbstractLabelOperator.EqualRegEx:
            operator = FilterOperator.Like;
            break;
          case AbstractLabelOperator.NotEqualRegEx:
            operator = FilterOperator.NotLike;
            break;
          default:
            operator = FilterOperator.Equals;
        }

        // Map well-known label names to OTEL column names
        const columnName = this._mapLabelToOtelColumn(matcher.name);

        return {
          condition: 'AND' as const,
          key: columnName,
          type: 'String',
          filterType: 'custom' as const,
          operator,
          value: matcher.operator === AbstractLabelOperator.EqualRegEx ||
                 matcher.operator === AbstractLabelOperator.NotEqualRegEx
            ? `%${matcher.value}%`
            : matcher.value,
        };
      });

      const defaultDb = this.getDefaultLogsDatabase() || this.getDefaultDatabase();
      const defaultTable = this.getDefaultLogsTable() || '';
      const columns = otelConfig?.logColumnMap
        ? Array.from(otelConfig.logColumnMap, ([hint, name]) => ({ name, hint }))
        : [];

      const builderOptions: QueryBuilderOptions = {
        database: defaultDb,
        table: defaultTable,
        queryType: QueryType.Logs,
        mode: BuilderMode.List,
        columns,
        filters,
        meta: {
          otelEnabled: Boolean(logsOtelVersion),
          otelVersion: logsOtelVersion || undefined,
        },
      };

      return {
        refId: abstractQuery.refId,
        pluginVersion,
        editorType: EditorType.Builder,
        rawSql: generateSql(builderOptions),
        builderOptions,
      };
    });
  }

  /**
   * T1.8: Export queries to abstract format for other datasources.
   * Extracts filters from ClickHouse queries into label matchers.
   */
  async exportToAbstractQueries(queries: CHQuery[]): Promise<AbstractQuery[]> {
    return queries.map((query) => {
      const labelMatchers: Array<{ name: string; value: string; operator: AbstractLabelOperator }> = [];

      if (query.editorType === EditorType.Builder && query.builderOptions?.filters) {
        for (const filter of query.builderOptions.filters) {
          if (!filter.key && !filter.hint) continue;
          if (filter.operator === FilterOperator.IsAnything) continue;

          let operator: AbstractLabelOperator;
          switch (filter.operator) {
            case FilterOperator.Equals:
              operator = AbstractLabelOperator.Equal;
              break;
            case FilterOperator.NotEquals:
              operator = AbstractLabelOperator.NotEqual;
              break;
            case FilterOperator.Like:
              operator = AbstractLabelOperator.EqualRegEx;
              break;
            case FilterOperator.NotLike:
              operator = AbstractLabelOperator.NotEqualRegEx;
              break;
            default:
              continue; // Skip non-mappable operators
          }

          const name = filter.key || (filter.hint ? this._mapHintToLabelName(filter.hint) : '');
          const value = 'value' in filter ? String(filter.value || '') : '';

          if (name && value) {
            labelMatchers.push({ name, value, operator });
          }
        }
      }

      return {
        refId: query.refId || 'A',
        labelMatchers,
      };
    });
  }

  /**
   * Maps common label names from other datasources to OTEL column names.
   */
  private _mapLabelToOtelColumn(label: string): string {
    const labelMap: Record<string, string> = {
      'service': 'ServiceName',
      'service_name': 'ServiceName',
      'servicename': 'ServiceName',
      'app': 'ServiceName',
      'application': 'ServiceName',
      'level': 'SeverityText',
      'severity': 'SeverityText',
      'log_level': 'SeverityText',
      'trace_id': 'TraceId',
      'traceid': 'TraceId',
      'span_id': 'SpanId',
      'spanid': 'SpanId',
      'namespace': "ResourceAttributes['service.namespace']",
      'k8s_namespace': "ResourceAttributes['k8s.namespace.name']",
      'pod': "ResourceAttributes['k8s.pod.name']",
      'container': "ResourceAttributes['k8s.container.name']",
    };
    return labelMap[label.toLowerCase()] || label;
  }

  /**
   * Maps ColumnHint back to common label names for export.
   */
  private _mapHintToLabelName(hint: ColumnHint): string {
    const hintMap: Record<string, string> = {
      [ColumnHint.TraceServiceName]: 'service',
      [ColumnHint.LogLevel]: 'level',
      [ColumnHint.TraceId]: 'trace_id',
      [ColumnHint.TraceSpanId]: 'span_id',
      [ColumnHint.LogMessage]: 'body',
      [ColumnHint.TraceOperationName]: 'operation',
    };
    return hintMap[hint] || hint;
  }

  private getMacroArgs(query: string, argsIndex: number): string[] {
    const args = [] as string[];
    const re = /\(|\)|,/g;
    let bracketCount = 0;
    let lastArgEndIndex = 1;
    let regExpArray: RegExpExecArray | null;
    const argsSubstr = query.substring(argsIndex, query.length);
    while ((regExpArray = re.exec(argsSubstr)) !== null) {
      const foundNode = regExpArray[0];
      if (foundNode === '(') {
        bracketCount++;
      } else if (foundNode === ')') {
        bracketCount--;
      }
      if (foundNode === ',' && bracketCount === 1) {
        args.push(argsSubstr.substring(lastArgEndIndex, re.lastIndex - 1));
        lastArgEndIndex = re.lastIndex;
      }
      if (bracketCount === 0) {
        args.push(argsSubstr.substring(lastArgEndIndex, re.lastIndex - 1));
        return args;
      }
    }
    return [];
  }

  private replace(value?: string, scopedVars?: ScopedVars) {
    if (value !== undefined) {
      return getTemplateSrv().replace(value, scopedVars, this.format);
    }
    return value;
  }

  private format(value: any) {
    if (Array.isArray(value)) {
      return `'${value.join("','")}'`;
    }
    return value;
  }

  getDefaultDatabase(): string {
    return this.settings.jsonData.defaultDatabase || 'default';
  }

  getDefaultTable(): string | undefined {
    return this.settings.jsonData.defaultTable;
  }

  getDefaultLogsDatabase(): string | undefined {
    return this.settings.jsonData.logs?.defaultDatabase;
  }

  getDefaultLogsTable(): string | undefined {
    return this.settings.jsonData.logs?.defaultTable;
  }

  getDefaultLogsColumns(): Map<ColumnHint, string> {
    const result = new Map<ColumnHint, string>();
    const logsConfig = this.settings.jsonData.logs;
    if (!logsConfig) {
      return result;
    }

    const otelEnabled = logsConfig.otelEnabled;
    const otelVersion = logsConfig.otelVersion;

    const otelConfig = otel.getVersion(otelVersion);
    if (otelEnabled && otelConfig) {
      return otelConfig.logColumnMap;
    }

    logsConfig.filterTimeColumn && result.set(ColumnHint.FilterTime, logsConfig.filterTimeColumn);
    logsConfig.timeColumn && result.set(ColumnHint.Time, logsConfig.timeColumn);
    logsConfig.levelColumn && result.set(ColumnHint.LogLevel, logsConfig.levelColumn);
    logsConfig.messageColumn && result.set(ColumnHint.LogMessage, logsConfig.messageColumn);

    return result;
  }

  shouldSelectLogContextColumns(): boolean {
    return this.settings.jsonData.logs?.selectContextColumns || false;
  }

  getLogContextColumnNames(): string[] {
    return this.settings.jsonData.logs?.contextColumns?.length ? this.settings.jsonData.logs?.contextColumns : [];
  }

  /**
   * Get configured OTEL version for logs. Returns undefined when versioning is disabled/unset.
   */
  getLogsOtelVersion(): string | undefined {
    const logConfig = this.settings.jsonData.logs;
    return logConfig?.otelEnabled ? logConfig.otelVersion || undefined : undefined;
  }

  getDefaultTraceDatabase(): string | undefined {
    return this.settings.jsonData.traces?.defaultDatabase;
  }

  getDefaultTraceTable(): string | undefined {
    return this.settings.jsonData.traces?.defaultTable;
  }

  getDefaultTraceColumns(): Map<ColumnHint, string> {
    const result = new Map<ColumnHint, string>();
    const traceConfig = this.settings.jsonData.traces;
    if (!traceConfig) {
      return result;
    }

    const otelEnabled = traceConfig.otelEnabled;
    const otelVersion = traceConfig.otelVersion;

    const otelConfig = otel.getVersion(otelVersion);
    if (otelEnabled && otelConfig) {
      return otelConfig.traceColumnMap;
    }

    traceConfig.traceIdColumn && result.set(ColumnHint.TraceId, traceConfig.traceIdColumn);
    traceConfig.spanIdColumn && result.set(ColumnHint.TraceSpanId, traceConfig.spanIdColumn);
    traceConfig.operationNameColumn && result.set(ColumnHint.TraceOperationName, traceConfig.operationNameColumn);
    traceConfig.parentSpanIdColumn && result.set(ColumnHint.TraceParentSpanId, traceConfig.parentSpanIdColumn);
    traceConfig.serviceNameColumn && result.set(ColumnHint.TraceServiceName, traceConfig.serviceNameColumn);
    traceConfig.durationColumn && result.set(ColumnHint.TraceDurationTime, traceConfig.durationColumn);
    traceConfig.startTimeColumn && result.set(ColumnHint.Time, traceConfig.startTimeColumn);
    traceConfig.tagsColumn && result.set(ColumnHint.TraceTags, traceConfig.tagsColumn);
    traceConfig.serviceTagsColumn && result.set(ColumnHint.TraceServiceTags, traceConfig.serviceTagsColumn);
    traceConfig.kindColumn && result.set(ColumnHint.TraceKind, traceConfig.kindColumn);
    traceConfig.statusCodeColumn && result.set(ColumnHint.TraceStatusCode, traceConfig.statusCodeColumn);
    traceConfig.statusMessageColumn && result.set(ColumnHint.TraceStatusMessage, traceConfig.statusMessageColumn);
    traceConfig.instrumentationLibraryNameColumn &&
      result.set(ColumnHint.TraceInstrumentationLibraryName, traceConfig.instrumentationLibraryNameColumn);
    traceConfig.instrumentationLibraryVersionColumn &&
      result.set(ColumnHint.TraceInstrumentationLibraryVersion, traceConfig.instrumentationLibraryVersionColumn);
    traceConfig.stateColumn && result.set(ColumnHint.TraceState, traceConfig.stateColumn);

    return result;
  }

  /**
   * Get configured OTEL version for traces. Returns undefined when versioning is disabled/unset.
   */
  getTraceOtelVersion(): string | undefined {
    const traceConfig = this.settings.jsonData.traces;
    return traceConfig?.otelEnabled ? traceConfig.otelVersion || undefined : undefined;
  }

  getDefaultTraceDurationUnit(): TimeUnit {
    return (this.settings.jsonData.traces?.durationUnit as TimeUnit) || TimeUnit.Nanoseconds;
  }

  getDefaultTraceFlattenNested(): boolean {
    return this.settings.jsonData.traces?.flattenNested || false;
  }

  getDefaultTraceEventsColumnPrefix(): string {
    return this.settings.jsonData.traces?.traceEventsColumnPrefix || 'Events';
  }

  getDefaultTraceLinksColumnPrefix(): string {
    return this.settings.jsonData.traces?.traceLinksColumnPrefix || 'Links';
  }

  /**
   * Get the TraceId column name from traces configuration
   * Used when creating logs filter to correlate with trace data
   */
  getTracesTraceIdColumn(): string | undefined {
    const traceConfig = this.settings.jsonData.traces;
    if (!traceConfig) {
      return undefined;
    }

    const otelEnabled = traceConfig.otelEnabled;
    const otelVersion = traceConfig.otelVersion;

    const otelConfig = otel.getVersion(otelVersion);
    if (otelEnabled && otelConfig) {
      return otelConfig.traceColumnMap.get(ColumnHint.TraceId);
    }

    return traceConfig.traceIdColumn;
  }

  async fetchDatabases(): Promise<string[]> {
    return this.fetchData('SHOW DATABASES');
  }

  async fetchTables(db?: string): Promise<string[]> {
    const rawSql = db ? `SHOW TABLES FROM "${db}"` : 'SHOW TABLES';
    return this.fetchData(rawSql);
  }

  /**
   * Used to populate suggestions in the filter editor for Map columns.
   *
   * Samples rows to get a unique set of keys for the map.
   * May not include ALL keys for a given dataset.
   *
   * TODO: This query can be slow/expensive
   */
  async fetchUniqueMapKeys(mapColumn: string, db: string, table: string): Promise<string[]> {
    const rawSql = `SELECT DISTINCT arrayJoin(${mapColumn}.keys) as keys FROM "${db}"."${table}" LIMIT 1000`;
    return this.fetchData(rawSql);
  }

  async fetchEntities() {
    return this.fetchTables();
  }

  async fetchFields(database: string, table: string): Promise<string[]> {
    return this.fetchData(`DESC TABLE "${database}"."${table}"`);
  }

  /**
   * Fetches JSON column suggestions for each specified JSON column.
   */
  async fetchPathsForJSONColumns(
    database: string | undefined,
    table: string,
    jsonColumnName: string
  ): Promise<TableColumn[]> {
    const prefix = Boolean(database) ? `"${database}".` : '';
    const rawSql = `SELECT arrayJoin(distinctJSONPathsAndTypes(${jsonColumnName})) FROM ${prefix}"${table}" SETTINGS max_execution_time=10`;
    const frame = await this.runQuery({ rawSql });
    if (frame.fields?.length === 0) {
      return [];
    }

    const view = new DataFrameView(frame);
    const jsonPathsAndTypes: Array<[string, string]> = [];
    for (let x of view) {
      if (!x || !x[0]) {
        continue;
      }

      const kv = typeof x[0] === 'string' ? JSON.parse(x[0]) : x[0];
      if (!kv.keys || !kv.values) {
        continue;
      }

      jsonPathsAndTypes.push([kv.keys, kv.values]);
    }

    const columns: TableColumn[] = [];
    for (let pathAndTypes of jsonPathsAndTypes) {
      const path = pathAndTypes[0];
      const types = pathAndTypes[1];
      if (!path || !types || types.length === 0) {
        continue;
      }

      columns.push({
        name: `${jsonColumnName}.${path}`,
        label: `${jsonColumnName}.${path}`,
        type: types[0],
        picklistValues: [],
      });
    }

    return columns;
  }

  /**
   * Fetches column suggestions from the table schema.
   */
  async fetchColumnsFromTable(database: string | undefined, table: string): Promise<TableColumn[]> {
    const prefix = Boolean(database) ? `"${database}".` : '';
    const rawSql = `DESC TABLE ${prefix}"${table}"`;
    const frame = await this.runQuery({ rawSql });
    if (frame.fields?.length === 0) {
      return [];
    }
    const view = new DataFrameView(frame);
    const columns: TableColumn[] = view.map((item) => ({
      name: item[0],
      type: item[1],
      label: item[0],
      picklistValues: [],
    }));

    return columns;

    // TODO: wait for JSON function perf improvements
    // const results = await Promise.all(
    //   columns
    //     .filter((c) => c.type.startsWith('JSON'))
    //     .map((c) => this.fetchPathsForJSONColumns(database, table, c.name))
    // );
    // return [...columns, ...results.flat()];
  }

  /**
   * Fetches SQL functions from server.
   */
  async fetchSqlFunctions(): Promise<SqlFunction[]> {
    const rawSql = `
      SELECT
        name, is_aggregate, case_insensitive, alias_to, origin, description,
        syntax, arguments, returned_value, examples, categories
      FROM system.functions
      LIMIT 10000
    `;
    const frame = await this.runQuery({ rawSql });
    if (frame.fields?.length === 0) {
      return [];
    }
    const view = new DataFrameView(frame);
    const sqlFunctions: SqlFunction[] = view.map((item) => ({
      name: String(item[0]),
      isAggregate: Boolean(item[1]),
      caseInsensitive: Boolean(item[2]),
      aliasTo: String(item[3]),
      origin: String(item[4]),
      description: String(item[5]),
      syntax: String(item[6]),
      arguments: String(item[7]),
      returnedValue: String(item[8]),
      examples: String(item[9]),
      categories: String(item[10]),
    }));

    return sqlFunctions;
  }

  /**
   * Fetches column suggestions from an alias definition table.
   */
  async fetchColumnsFromAliasTable(fullTableName: string): Promise<TableColumn[]> {
    const rawSql = `SELECT alias, select, "type" FROM ${fullTableName}`;
    const frame = await this.runQuery({ rawSql });
    if (frame.fields?.length === 0) {
      return [];
    }
    const view = new DataFrameView(frame);
    return view.map((item) => ({
      name: item[1],
      type: item[2],
      label: item[0],
      picklistValues: [],
    }));
  }

  getAliasTable(targetDatabase: string | undefined, targetTable: string): string | null {
    const aliasEntries = this.settings?.jsonData?.aliasTables || [];
    const matchedEntry =
      aliasEntries.find((e) => {
        const matchDatabase = !e.targetDatabase || e.targetDatabase === targetDatabase;
        const matchTable = e.targetTable === targetTable;
        return matchDatabase && matchTable;
      }) || null;

    if (matchedEntry === null) {
      return null;
    }

    const aliasDatabase = matchedEntry.aliasDatabase || targetDatabase || null;
    const aliasTable = matchedEntry.aliasTable;
    const prefix = Boolean(aliasDatabase) ? `"${aliasDatabase}".` : '';
    return `${prefix}"${aliasTable}"`;
  }

  async fetchColumns(database: string | undefined, table: string): Promise<TableColumn[]> {
    const fullAliasTableName = this.getAliasTable(database, table);
    if (fullAliasTableName !== null) {
      return this.fetchColumnsFromAliasTable(fullAliasTableName);
    }

    return this.fetchColumnsFromTable(database, table);
  }

  private async fetchData(rawSql: string) {
    const frame = await this.runQuery({ rawSql });
    return this.values(frame);
  }

  private getTimezone(request: DataQueryRequest<CHQuery>): string | undefined {
    // timezone specified in the time picker
    if (request.timezone && request.timezone !== 'browser') {
      return request.timezone;
    }
    // fall back to the local timezone
    const localTimezoneInfo = getTimeZoneInfo(getTimeZone(), Date.now());
    return localTimezoneInfo?.ianaName;
  }

  filterQuery(query: CHQuery): boolean {
    return !query.hide;
  }

  query(request: DataQueryRequest<CHQuery>): Observable<DataQueryResponse> {
    const targets = request.targets
      // attach timezone information
      .map((t) => {
        return {
          ...t,
          meta: {
            ...t?.meta,
            timezone: this.getTimezone(request),
          },
        };
      });

    const hasLogsVolumeTargets = targets.some((t) => t.refId?.startsWith(Datasource.logVolumePrefix));

    return super
      .query({
        ...request,
        targets,
      })
        // Skip data link enrichment for supplementary queries (log volume, log sample).
        // These go through Grafana's frame deep-clone which stack-overflows on the
        // data link query objects. hideFromInspector is set by getDataProvider().
        if (request.hideFromInspector) {
          if (hasLogsVolumeTargets) {
            return { ...res, data: splitLogsVolumeFrames(res.data, Datasource.logVolumePrefix) };
          }
          return res;
        }
        const transformed = transformQueryResponseWithTraceAndLogLinks(this, request, res);
        if (hasLogsVolumeTargets) {
          return { ...transformed, data: splitLogsVolumeFrames(transformed.data, Datasource.logVolumePrefix) };
        }
        return transformed;
      }));
  }

  private runQuery(request: Partial<CHQuery>, options?: any): Promise<DataFrame> {
    return new Promise((resolve) => {
      const req = {
        targets: [{ ...request, refId: String(Math.random()) }],
        range: options ? options.range : (getTemplateSrv() as any).timeRange,
      } as DataQueryRequest<CHQuery>;
      this.query(req).subscribe((res: DataQueryResponse) => {
        resolve(res.data[0] || { fields: [] });
      });
    });
  }

  private values(frame: DataFrame) {
    if (frame.fields?.length === 0) {
      return [];
    }
    return frame?.fields[0]?.values.map((text) => text);
  }

  async getTagKeys(): Promise<MetricFindValue[]> {
    if (this.adHocFiltersStatus === AdHocFilterStatus.disabled || this.adHocFiltersStatus === AdHocFilterStatus.none) {
      this.adHocFiltersStatus = await this.canUseAdhocFilters();
      if (this.adHocFiltersStatus === AdHocFilterStatus.disabled) {
        return {} as MetricFindValue[];
      }
    }
    const { type, frame } = await this.fetchTags();
    if (type === TagType.query) {
      return frame.fields.map((f) => ({ text: f.name }));
    }
    const view = new DataFrameView(frame);
    const hideTableName = this.settings.jsonData.hideTableNameInAdhocFilters || false;
    return view.map((item) => ({
      text: hideTableName ? item[0] : `${item[2]}.${item[0]}`,
    }));
  }

  async getTagValues({ key }: any): Promise<MetricFindValue[]> {
    const { type } = this.getTagSource();
    this.skipAdHocFilter = true;
    if (type === TagType.query) {
      return this.fetchTagValuesFromQuery(key);
    }
    return this.fetchTagValuesFromSchema(key);
  }

  private fieldValuesToMetricFindValues(field: Field): MetricFindValue[] {
    // Convert to string to avoid https://github.com/grafana/grafana/issues/12209
    return field.values
      .filter((value) => value !== null)
      .map((value) => {
        return { text: String(value) };
      });
  }

  private async fetchTagValuesFromSchema(key: string): Promise<MetricFindValue[]> {
    const { from } = this.getTagSource();
    const hideTableName = this.settings.jsonData.hideTableNameInAdhocFilters || false;

    let col: string;
    let source: string;

    if (hideTableName && from) {
      // When hideTableNameInAdhocFilters is true, key is just the column name (e.g., 'bar')
      col = key;
      source = from;
    } else {
      // When hideTableNameInAdhocFilters is false, key is 'table.column' format (e.g., 'foo.bar')
      const [table, ...colParts] = key.split('.');
      col = colParts.join('.');
      source = from?.includes('.') ? `${from.split('.')[0]}.${table}` : table;
    }

    const rawSql = `select distinct ${col} from ${source} limit 1000`;
    const frame = await this.runQuery({ rawSql });
    if (frame.fields?.length === 0) {
      return [];
    }
    const field = frame.fields[0];
    return this.fieldValuesToMetricFindValues(field);
  }

  private async fetchTagValuesFromQuery(key: string): Promise<MetricFindValue[]> {
    const tagSource = this.getTagSource();

    // Check if the query contains the $__adhoc_column macro
    if (tagSource.source && tagSource.source.includes('$__adhoc_column')) {
      // Replace the macro with the actual column name
      const queryWithColumn = tagSource.source.replace(/\$__adhoc_column/g, key);
      this.skipAdHocFilter = true;
      const frame = await this.runQuery({ rawSql: queryWithColumn });

      if (frame.fields?.length === 0) {
        return [];
      }

      const field = frame.fields[0];
      return this.fieldValuesToMetricFindValues(field);
    }

    // Fallback to the original behavior
    const { frame } = await this.fetchTags();
    const field = frame.fields.find((f) => f.name === key);
    if (field) {
      return this.fieldValuesToMetricFindValues(field);
    }
    return [];
  }

  private async fetchTags(): Promise<Tags> {
    const tagSource = this.getTagSource();
    this.skipAdHocFilter = true;

    if (tagSource.source === undefined) {
      const rawSql = 'SELECT name, type, table FROM system.columns';
      const results = await this.runQuery({ rawSql });
      return { type: TagType.schema, frame: results };
    }

    if (tagSource.type === TagType.query) {
      // Check if the query contains the $__adhoc_column macro
      if (tagSource.source.includes('$__adhoc_column')) {
        // Extract table name from the query and get column list from system.columns
        const tableName = this.extractTableNameFromQuery(tagSource.source);
        if (tableName) {
          this.adHocFilter.setTargetTableFromQuery(tagSource.source.replace(/\$__adhoc_column/g, '*'));

          // Parse database.table format
          const parts = tableName.split('.');
          let query: string;
          if (parts.length === 2) {
            const [db, table] = parts;
            query = `SELECT name, type, table FROM system.columns WHERE database = '${db}' AND table = '${table}'`;
          } else {
            query = `SELECT name, type, table FROM system.columns WHERE table = '${tableName}'`;
          }
          const results = await this.runQuery({ rawSql: query });
          return { type: TagType.schema, frame: results };
        }
      } else {
        this.adHocFilter.setTargetTableFromQuery(tagSource.source);
      }
    }

    const results = await this.runQuery({ rawSql: tagSource.source });
    return { type: tagSource.type, frame: results };
  }

  private extractTableNameFromQuery(query: string): string | null {
    // Try to extract table name from FROM clause
    // Supports formats: FROM table, FROM database.table, FROM "database"."table"
    const fromMatch = query.match(/FROM\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i);
    if (fromMatch) {
      const database = fromMatch[1];
      const table = fromMatch[2];
      return database ? `${database}.${table}` : table;
    }
    return null;
  }

  private getTagSource() {
    // @todo https://github.com/grafana/grafana/issues/13109
    const ADHOC_VAR = '$clickhouse_adhoc_query';
    const defaultDatabase = this.getDefaultDatabase();
    let source = getTemplateSrv().replace(ADHOC_VAR);
    if (source === ADHOC_VAR && isEmpty(defaultDatabase)) {
      return { type: TagType.schema, source: undefined };
    }
    source = source === ADHOC_VAR ? defaultDatabase! : source;
    if (source.toLowerCase().startsWith('select')) {
      return { type: TagType.query, source };
    }
    if (!source.includes('.')) {
      const sql = `SELECT name, type, table FROM system.columns WHERE database IN ('${source}')`;
      return { type: TagType.schema, source: sql, from: source };
    }
    const [db, table] = source.split('.');
    const sql = `SELECT name, type, table FROM system.columns WHERE database IN ('${db}') AND table = '${table}'`;
    return { type: TagType.schema, source: sql, from: source };
  }

  // Returns true if ClickHouse's version is greater than or equal to 22.7
  // 22.7 added 'settings additional_table_filters' which is used for ad hoc filters
  private async canUseAdhocFilters(): Promise<AdHocFilterStatus> {
    this.skipAdHocFilter = true;
    const data = await this.fetchData(`SELECT version()`);
    try {
      const verString = (data[0] as unknown as string).split('.');
      const ver = { major: Number.parseInt(verString[0], 10), minor: Number.parseInt(verString[1], 10) };
      return ver.major > this.adHocCHVerReq.major ||
        (ver.major === this.adHocCHVerReq.major && ver.minor >= this.adHocCHVerReq.minor)
        ? AdHocFilterStatus.enabled
        : AdHocFilterStatus.disabled;
    } catch (err) {
      console.error(`Unable to parse ClickHouse version: ${err}`);
      throw err;
    }
  }

  // interface DataSourceWithLogsContextSupport
  getLogContextColumnsFromLogRow(row: LogRowModel): LogContextColumn[] {
    const contextColumnNames = this.getLogContextColumnNames();
    const contextColumns: LogContextColumn[] = [];

    for (let columnName of contextColumnNames) {
      const isMapKey = columnName.includes("['") && columnName.includes("']");
      let mapName = '';
      let keyName = '';
      if (isMapKey) {
        mapName = columnName.substring(0, columnName.indexOf('['));
        keyName = columnName.substring(columnName.indexOf("['") + 2, columnName.lastIndexOf("']"));
      }

      const field = row.dataFrame.fields.find(
        (f) =>
          // exact column name match
          f.name === columnName ||
          (isMapKey &&
            // entire map was selected
            (f.name === mapName ||
              // single key was selected from map
              f.name === `arrayElement(${mapName}, '${keyName}')` ||
              f.name === 'labels'
            )
          )
      );
      if (!field) {
        continue;
      }

      let value = field.values.get(row.rowIndex);
      if (value && field.type === 'other' && isMapKey) {
        // Extract merged Resource/Log Attributes from "labels"
        if (field.name === labelsFieldName) {
          value = value[`${mapName}.${keyName}`];
        } else {
          value = value[keyName];
        }
      }

      if (!value) {
        continue;
      }

      let contextColumnName: string;
      if (isMapKey) {
        contextColumnName = `${mapName}['${keyName}']`;
      } else {
        contextColumnName = columnName;
      }

      contextColumns.push({
        name: contextColumnName,
        value,
      });
    }

    return contextColumns;
  }

  /**
   * Runs a query based on a single log row and a direction (forward/backward)
   *
   * Will remove all filters and ORDER BYs, and will re-add them based on the configured context columns.
   * Context columns are used to narrow down to a single logging unit as defined by your logging infrastructure.
   * Typically this will be a single service, or container/pod in docker/k8s.
   *
   * If no context columns can be matched from the selected data frame, then the query is not run.
   */
  async getLogRowContext(
    row: LogRowModel,
    options?: LogRowContextOptions,
    query?: CHQuery | undefined,
    cacheFilters?: boolean
  ): Promise<DataQueryResponse> {
    if (!query) {
      throw new Error('Missing query for log context');
    } else if (!options || !options.direction || options.limit === undefined) {
      throw new Error('Missing log context options for query');
    }

    // T3.2: Support SQL mode by generating a context query from OTEL config
    if (query.editorType === EditorType.SQL || !query.builderOptions) {
      return this._getLogRowContextFromOtelConfig(row, options);
    }

    const contextQuery = cloneDeep(query);
    contextQuery.refId = '';
    const builderOptions = contextQuery.builderOptions;
    builderOptions.limit = options.limit;

    const timeColumn = getColumnByHint(builderOptions, ColumnHint.FilterTime) || getColumnByHint(builderOptions, ColumnHint.Time)
    if (!timeColumn) {
      throw new Error('Missing time column for log context');
    }

    builderOptions.orderBy = [];
    builderOptions.orderBy.push({
      name: '',
      hint: timeColumn.hint!,
      dir: options.direction === LogRowContextQueryDirection.Forward ? OrderByDirection.ASC : OrderByDirection.DESC,
    });

    builderOptions.filters = [];
    builderOptions.filters.push({
      operator:
        options.direction === LogRowContextQueryDirection.Forward
          ? FilterOperator.GreaterThanOrEqual
          : FilterOperator.LessThanOrEqual,
      filterType: 'custom',
      hint: timeColumn.hint!,
      key: '',
      value: `fromUnixTimestamp64Nano(${row.timeEpochNs})`,
      type: 'datetime',
      condition: 'AND',
    });

    const contextColumns = this.getLogContextColumnsFromLogRow(row);
    if (contextColumns.length < 1) {
      throw new Error('Unable to match any log context columns');
    }

    const contextColumnFilters: Filter[] = contextColumns.map((c) => ({
      operator: FilterOperator.Equals,
      filterType: 'custom',
      key: c.name,
      value: c.value,
      type: 'string',
      condition: 'AND',
    }));
    builderOptions.filters.push(...contextColumnFilters);

    contextQuery.rawSql = generateSql(builderOptions);
    const req = {
      targets: [contextQuery],
    } as DataQueryRequest<CHQuery>;

    return await firstValueFrom(this.query(req));
  }

  /**
   * T3.2: Generate log context for SQL mode queries using OTEL config.
   * When user writes raw SQL but has OTEL configured, we can still show context
   * by generating a builder-mode query from the OTEL column mappings.
   */
  private async _getLogRowContextFromOtelConfig(
    row: LogRowModel,
    options: LogRowContextOptions
  ): Promise<DataQueryResponse> {
    const logsOtelVersion = this.getLogsOtelVersion();
    const otelConfig = logsOtelVersion ? otel.getVersion(logsOtelVersion) : undefined;

    if (!otelConfig) {
      throw new Error('Log context for SQL mode requires OTEL configuration. Enable OTEL in datasource settings or use the Query Builder.');
    }

    const database = this.getDefaultLogsDatabase() || this.getDefaultDatabase();
    const table = this.getDefaultLogsTable() || '';
    if (!table) {
      throw new Error('Log context for SQL mode requires a default logs table in datasource settings.');
    }

    const columns = Array.from(otelConfig.logColumnMap, ([hint, name]) => ({ name, hint }));
    const timeColumn = columns.find(c => c.hint === ColumnHint.FilterTime || c.hint === ColumnHint.Time);
    if (!timeColumn) {
      throw new Error('Missing time column in OTEL log column mapping');
    }

    const direction = options.direction === LogRowContextQueryDirection.Forward ? OrderByDirection.ASC : OrderByDirection.DESC;
    const timeOp = options.direction === LogRowContextQueryDirection.Forward
      ? FilterOperator.GreaterThanOrEqual
      : FilterOperator.LessThanOrEqual;

    const contextColumns = this.getLogContextColumnsFromLogRow(row);
    const contextFilters: Filter[] = contextColumns.map((c) => ({
      operator: FilterOperator.Equals,
      filterType: 'custom' as const,
      key: c.name,
      value: c.value,
      type: 'string',
      condition: 'AND' as const,
    }));

    const builderOptions: QueryBuilderOptions = {
      database,
      table,
      queryType: QueryType.Logs,
      mode: BuilderMode.List,
      columns,
      filters: [
        {
          operator: timeOp,
          filterType: 'custom',
          hint: timeColumn.hint!,
          key: '',
          value: `fromUnixTimestamp64Nano(${row.timeEpochNs})`,
          type: 'datetime',
          condition: 'AND',
        },
        ...contextFilters,
      ],
      orderBy: [{ name: '', hint: timeColumn.hint!, dir: direction }],
      limit: options.limit,
      meta: {
        otelEnabled: true,
        otelVersion: logsOtelVersion,
      },
    };

    const contextQuery: CHQuery = {
      refId: '',
      pluginVersion,
      editorType: EditorType.Builder,
      rawSql: generateSql(builderOptions),
      builderOptions,
    };

    const req = {
      targets: [contextQuery],
    } as DataQueryRequest<CHQuery>;

    return await firstValueFrom(this.query(req));
  }

  /**
   * Unused + deprecated but required by interface, log context button is always visible now
   * https://github.com/grafana/grafana/issues/66819
   */
  showContextToggle(row?: LogRowModel): boolean {
    return true;
  }

  /**
   * Returns a React component that is displayed in the top portion of the log context panel
   */
  getLogRowContextUi(
    row: LogRowModel,
    runContextQuery?: (() => void) | undefined,
    query?: CHQuery | undefined
  ): ReactNode {
    const contextColumns = this.getLogContextColumnsFromLogRow(row);
    return createReactElement(LogsContextPanel, { columns: contextColumns, datasourceUid: this.uid });
  }
}

enum TagType {
  query,
  schema,
}

enum AdHocFilterStatus {
  none = 0,
  enabled,
  disabled,
}

interface Tags {
  type?: TagType;
  frame: DataFrame;
}

export interface LogContextColumn {
  name: string;
  value: string;
}
