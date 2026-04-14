import React, { useCallback } from 'react';
import { CustomVariableSupport, DataQueryRequest, DataQueryResponse, QueryEditorProps } from '@grafana/data';
import { InlineFormLabel, Select, Input } from '@grafana/ui';
import { Observable, from, of } from 'rxjs';
import { Datasource } from './CHDatasource';
import { CHQuery, EditorType } from 'types/sql';
import { CHConfig } from 'types/config';
import { SchemaPicker, SchemaPickerValue } from 'components/queryBuilder/SchemaPicker';

type VariableQueryType = 'sql' | 'column_values' | 'columns' | 'tables' | 'databases' | 'otel_services' | 'otel_levels' | 'otel_operations';

/**
 * Variable query model — serialized in dashboard JSON
 */
interface CHVariableQuery {
  refId: string;
  queryType: VariableQueryType;
  rawSql?: string;
  database?: string;
  table?: string;
  column?: string;
  mapKey?: string;
}

/**
 * Generate SQL from variable type and schema selections
 */
function generateVariableSQL(
  queryType: VariableQueryType,
  schema: SchemaPickerValue,
  defaultDb: string
): string {
  switch (queryType) {
    case 'databases':
      return 'SELECT name FROM system.databases ORDER BY name';
    case 'tables':
      if (!schema.database) {
        return '';
      }
      return `SELECT name FROM system.tables WHERE database = '${schema.database}' ORDER BY name`;
    case 'columns':
      if (!schema.database || !schema.table) {
        return '';
      }
      return `SELECT name FROM system.columns WHERE database = '${schema.database}' AND table = '${schema.table}' ORDER BY name`;
    case 'column_values': {
      if (!schema.database || !schema.table || !schema.column) {
        return '';
      }
      const colExpr = schema.mapKey ? `${schema.column}['${schema.mapKey}']` : schema.column;
      const fullTable = `${schema.database}.${schema.table}`;
      return `SELECT DISTINCT ${colExpr} FROM ${fullTable} WHERE $__timeFilter(Timestamp) AND ${colExpr} != '' ORDER BY 1 LIMIT 1000`;
    }
    case 'otel_services':
      return `SELECT DISTINCT ServiceName FROM ${defaultDb || 'otel_v2'}.otel_logs WHERE $__timeFilter(Timestamp) ORDER BY ServiceName`;
    case 'otel_levels':
      return `SELECT DISTINCT SeverityText FROM ${defaultDb || 'otel_v2'}.otel_logs WHERE $__timeFilter(Timestamp) ORDER BY SeverityText`;
    case 'otel_operations':
      return `SELECT DISTINCT SpanName FROM ${defaultDb || 'otel_v2'}.otel_traces WHERE $__timeFilter(Timestamp) ORDER BY SpanName LIMIT 200`;
    default:
      return '';
  }
}

const QUERY_TYPE_OPTIONS = [
  { label: 'Custom SQL', value: 'sql' as VariableQueryType },
  { label: 'List databases', value: 'databases' as VariableQueryType },
  { label: 'List tables', value: 'tables' as VariableQueryType },
  { label: 'List columns', value: 'columns' as VariableQueryType },
  { label: 'Column values', value: 'column_values' as VariableQueryType, description: 'Distinct values from a column, with Map key support' },
  { label: 'OTEL: Service names', value: 'otel_services' as VariableQueryType, icon: 'bolt' as any },
  { label: 'OTEL: Log levels', value: 'otel_levels' as VariableQueryType, icon: 'bolt' as any },
  { label: 'OTEL: Operations', value: 'otel_operations' as VariableQueryType, icon: 'bolt' as any },
];

/**
 * Schema picker depth per query type
 */
function getSchemaLevel(queryType: VariableQueryType) {
  switch (queryType) {
    case 'tables':
      return 'database' as const;
    case 'columns':
      return 'table' as const;
    case 'column_values':
      return 'mapKey' as const;
    default:
      return undefined;
  }
}

/**
 * T1.7: Variable editor component — provides guided pickers instead of raw SQL
 */
const VariableQueryEditor = (props: QueryEditorProps<Datasource, CHQuery, CHConfig, CHVariableQuery>) => {
  const { query, onChange, datasource } = props;
  const varQuery = (query || {}) as CHVariableQuery;
  const queryType = varQuery.queryType || 'sql';

  const schemaValue: SchemaPickerValue = {
    database: varQuery.database,
    table: varQuery.table,
    column: varQuery.column,
    mapKey: varQuery.mapKey,
  };

  const onQueryTypeChange = useCallback(
    (value: VariableQueryType) => {
      const updated: CHVariableQuery = {
        ...varQuery,
        queryType: value,
      };
      updated.rawSql = generateVariableSQL(value, schemaValue, datasource.getDefaultDatabase?.() || '');
      onChange(updated as any);
    },
    [varQuery, onChange, datasource, schemaValue]
  );

  const onSchemaChange = useCallback(
    (newSchema: SchemaPickerValue) => {
      const updated: CHVariableQuery = {
        ...varQuery,
        database: newSchema.database,
        table: newSchema.table,
        column: newSchema.column,
        mapKey: newSchema.mapKey,
      };
      updated.rawSql = generateVariableSQL(updated.queryType, newSchema, datasource.getDefaultDatabase?.() || '');
      onChange(updated as any);
    },
    [varQuery, onChange, datasource]
  );

  const schemaLevel = getSchemaLevel(queryType);

  const schemaLabels = queryType === 'column_values'
    ? { column: 'Column', mapKey: 'Map Key' }
    : undefined;

  return (
    <div>
      <div className="gf-form">
        <InlineFormLabel width={10}>Variable Type</InlineFormLabel>
        <Select
          width={30}
          options={QUERY_TYPE_OPTIONS}
          value={queryType}
          onChange={(v) => onQueryTypeChange(v.value || 'sql')}
        />
      </div>

      {schemaLevel && (
        <SchemaPicker
          datasource={datasource}
          value={schemaValue}
          onChange={onSchemaChange}
          level={schemaLevel}
          labels={schemaLabels}
        />
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

    const promise = this.datasource.metricFindQuery(
      { rawSql: query.rawSql, editorType: EditorType.SQL } as CHQuery,
      { range: request.range }
    ).then((values) => {
      return { data: values.map((v) => v) } as DataQueryResponse;
    });

    return from(promise);
  }
}
