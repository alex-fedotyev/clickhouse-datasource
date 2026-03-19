import React, { useState, useEffect, useCallback } from 'react';
import { CustomVariableSupport, DataQueryRequest, DataQueryResponse, QueryEditorProps } from '@grafana/data';
import { InlineFormLabel, Select, Input } from '@grafana/ui';
import { Observable, from, of } from 'rxjs';
import { Datasource } from './CHDatasource';
import { CHQuery, EditorType } from 'types/sql';
import { CHConfig } from 'types/config';
import { QueryBuilderOptions, QueryType } from 'types/queryBuilder';

/**
 * Variable query model — serialized in dashboard JSON
 */
interface CHVariableQuery {
  refId: string;
  queryType: 'sql' | 'columns' | 'tables' | 'databases' | 'otel_services' | 'otel_levels' | 'otel_operations';
  rawSql?: string;
  database?: string;
  table?: string;
  column?: string;
}

/**
 * T1.7: Variable editor component — provides guided pickers instead of raw SQL
 */
const VariableQueryEditor = (props: QueryEditorProps<Datasource, CHQuery, CHConfig, CHVariableQuery>) => {
  const { query, onChange, datasource } = props;
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);

  const varQuery = (query || {}) as CHVariableQuery;
  const queryType = varQuery.queryType || 'sql';

  useEffect(() => {
    // Fetch databases on mount
    datasource.fetchDatabases().then(setDatabases).catch(() => {});
  }, [datasource]);

  useEffect(() => {
    if (varQuery.database) {
      datasource.fetchTables(varQuery.database).then(setTables).catch(() => {});
    }
  }, [datasource, varQuery.database]);

  const onQueryTypeChange = useCallback(
    (value: string) => {
      const updated = { ...varQuery, queryType: value as CHVariableQuery['queryType'] };

      // Auto-fill SQL for OTEL presets
      if (value === 'otel_services') {
        updated.rawSql = `SELECT DISTINCT ServiceName FROM ${datasource.getDefaultDatabase()}.otel_logs WHERE $__timeFilter(Timestamp) ORDER BY ServiceName`;
      } else if (value === 'otel_levels') {
        updated.rawSql = `SELECT DISTINCT SeverityText FROM ${datasource.getDefaultDatabase()}.otel_logs WHERE $__timeFilter(Timestamp) ORDER BY SeverityText`;
      } else if (value === 'otel_operations') {
        updated.rawSql = `SELECT DISTINCT SpanName FROM ${datasource.getDefaultDatabase()}.otel_traces WHERE $__timeFilter(Timestamp) ORDER BY SpanName LIMIT 200`;
      } else if (value === 'databases') {
        updated.rawSql = `SELECT name FROM system.databases ORDER BY name`;
      } else if (value === 'tables' && varQuery.database) {
        updated.rawSql = `SELECT name FROM system.tables WHERE database = '${varQuery.database}' ORDER BY name`;
      } else if (value === 'columns' && varQuery.database && varQuery.table) {
        updated.rawSql = `SELECT name FROM system.columns WHERE database = '${varQuery.database}' AND table = '${varQuery.table}' ORDER BY name`;
      }

      onChange(updated as any);
    },
    [varQuery, onChange, datasource]
  );

  const queryTypeOptions = [
    { label: 'Custom SQL', value: 'sql' },
    { label: 'List databases', value: 'databases' },
    { label: 'List tables', value: 'tables' },
    { label: 'List columns', value: 'columns' },
    { label: 'OTEL: Service names', value: 'otel_services', icon: 'bolt' },
    { label: 'OTEL: Log levels', value: 'otel_levels', icon: 'bolt' },
    { label: 'OTEL: Operations', value: 'otel_operations', icon: 'bolt' },
  ];

  return (
    <div>
      <div className="gf-form">
        <InlineFormLabel width={10}>Variable Type</InlineFormLabel>
        <Select
          width={30}
          options={queryTypeOptions}
          value={queryType}
          onChange={(v) => onQueryTypeChange(v.value || 'sql')}
        />
      </div>

      {(queryType === 'tables' || queryType === 'columns') && (
        <div className="gf-form">
          <InlineFormLabel width={10}>Database</InlineFormLabel>
          <Select
            width={30}
            options={databases.map((d) => ({ label: d, value: d }))}
            value={varQuery.database || ''}
            onChange={(v) => {
              const updated = { ...varQuery, database: v.value || '' };
              if (queryType === 'tables') {
                updated.rawSql = `SELECT name FROM system.tables WHERE database = '${v.value}' ORDER BY name`;
              }
              onChange(updated as any);
            }}
            isClearable
            placeholder="Select database"
          />
        </div>
      )}

      {queryType === 'columns' && (
        <div className="gf-form">
          <InlineFormLabel width={10}>Table</InlineFormLabel>
          <Select
            width={30}
            options={tables.map((t) => ({ label: t, value: t }))}
            value={varQuery.table || ''}
            onChange={(v) => {
              const updated = {
                ...varQuery,
                table: v.value || '',
                rawSql: `SELECT DISTINCT ${varQuery.column || 'name'} FROM ${varQuery.database}.${v.value} ORDER BY 1 LIMIT 1000`,
              };
              onChange(updated as any);
            }}
            isClearable
            placeholder="Select table"
          />
        </div>
      )}

      <div className="gf-form">
        <InlineFormLabel width={10}>SQL Query</InlineFormLabel>
        <Input
          width={80}
          value={varQuery.rawSql || ''}
          onChange={(e) => onChange({ ...varQuery, rawSql: e.currentTarget.value } as any)}
          placeholder="SELECT DISTINCT column FROM database.table"
        />
      </div>
    </div>
  );
};

/**
 * T1.7: CustomVariableSupport implementation
 * Registers a guided variable editor with OTEL presets
 */
export class CHVariableSupport extends CustomVariableSupport<Datasource, CHVariableQuery> {
  constructor(private readonly datasource: Datasource) {
    super();
  }

  editor = VariableQueryEditor;

  query(request: DataQueryRequest<CHVariableQuery>): Observable<DataQueryResponse> {
    const query = request.targets[0];
    if (!query?.rawSql) {
      return of({ data: [] });
    }

    // Delegate to the datasource's existing metricFindQuery
    const promise = this.datasource.metricFindQuery(
      { rawSql: query.rawSql, editorType: EditorType.SQL } as CHQuery,
      { range: request.range }
    ).then((values) => {
      return {
        data: values.map((v) => v),
      } as DataQueryResponse;
    });

    return from(promise);
  }
}
