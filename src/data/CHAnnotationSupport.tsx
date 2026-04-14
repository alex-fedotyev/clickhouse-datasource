import React, { useCallback } from 'react';
import {
  AnnotationQuery,
  AnnotationSupport,
  GrafanaTheme2,
  QueryEditorProps,
} from '@grafana/data';
import { InlineFormLabel, Select, TextArea, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { Datasource } from './CHDatasource';
import { CHQuery, EditorType } from 'types/sql';
import { CHConfig } from 'types/config';
import { SchemaPicker, SchemaPickerValue } from 'components/queryBuilder/SchemaPicker';
import useColumns from 'hooks/useColumns';

/**
 * Annotation preset types
 */
type AnnotationPreset = 'custom' | 'change_detection' | 'k8s_events';

/**
 * Extended annotation query with builder state for change detection
 */
interface CHAnnotationQuery extends AnnotationQuery<CHQuery> {
  preset?: AnnotationPreset;
  changeDetection?: SchemaPickerValue & { groupBy?: string };
}

/**
 * Generate the change detection SQL from builder selections.
 * Uses lagInFrame() with 30-second bucketing to detect transitions,
 * including rollbacks (v1 -> v2 -> v1 produces 3 annotations).
 */
function generateChangeDetectionSQL(opts: SchemaPickerValue & { groupBy?: string }): string {
  const { database, table, column, mapKey, groupBy } = opts;
  if (!table || !column) {
    return '-- Select a table and column above to generate the change detection query';
  }

  const fullTable = database ? `${database}.${table}` : table;
  const columnExpr = mapKey ? `${column}['${mapKey}']` : column;
  const groupByCol = groupBy || 'ServiceName';
  const displayLabel = mapKey ? `${column}.${mapKey}` : column;

  return [
    'SELECT',
    '  time,',
    `  ${groupByCol} AS tags,`,
    `  concat(${groupByCol}, ': ${displayLabel} changed to ', version,`,
    `    if(prev_version != '', concat(' (was ', prev_version, ')'), '')) AS text,`,
    `  '${displayLabel} change' AS title`,
    'FROM (',
    '  SELECT',
    '    toStartOfInterval(Timestamp, INTERVAL 30 second) AS time,',
    `    ${groupByCol},`,
    `    any(${columnExpr}) AS version,`,
    `    lagInFrame(any(${columnExpr}))`,
    `      OVER (PARTITION BY ${groupByCol} ORDER BY time) AS prev_version`,
    `  FROM ${fullTable}`,
    '  WHERE $__timeFilter(Timestamp)',
    `    AND ${columnExpr} != ''`,
    `  GROUP BY ${groupByCol}, time`,
    `  ORDER BY ${groupByCol}, time`,
    ')',
    'WHERE prev_version != version',
    'ORDER BY time',
  ].join('\n');
}

function generateK8sEventsSQL(defaultDb: string): string {
  const table = defaultDb ? `${defaultDb}.otel_logs` : 'otel_logs';
  return [
    'SELECT',
    '  Timestamp AS time,',
    '  Body AS text,',
    "  ResourceAttributes['k8s.namespace.name'] AS tags,",
    "  concat(ResourceAttributes['k8s.pod.name'], ': ', SeverityText) AS title",
    `FROM ${table}`,
    'WHERE $__timeFilter(Timestamp)',
    "  AND LogAttributes['event.domain'] = 'k8s'",
    'ORDER BY Timestamp',
    'LIMIT 200',
  ].join('\n');
}

const PRESET_OPTIONS = [
  { label: 'Custom SQL', value: 'custom' as AnnotationPreset, description: 'Write your own annotation query' },
  { label: 'Change Detection', value: 'change_detection' as AnnotationPreset, description: 'Detect when a column value changes (deployments, config changes, rollbacks)', icon: 'rocket' },
  { label: 'K8s Lifecycle Events', value: 'k8s_events' as AnnotationPreset, description: 'Surface Kubernetes events (restarts, OOM kills, scaling)', icon: 'kubernetes' },
];

/**
 * Annotation query editor with preset selector and change detection builder
 */
const AnnotationQueryEditor = (
  props: QueryEditorProps<Datasource, CHQuery, CHConfig> & {
    annotation?: CHAnnotationQuery;
    onAnnotationChange?: (annotation: CHAnnotationQuery) => void;
  }
) => {
  const { annotation, onAnnotationChange, datasource } = props;
  const anno = (annotation || {}) as CHAnnotationQuery;
  const preset = anno.preset || 'custom';
  const cd = anno.changeDetection || {};
  const styles = useStyles2(getStyles);

  // Fetch columns for the group-by picker (reuses the same shared hook)
  const columns = useColumns(datasource, cd.database || '', cd.table || '');

  const updateChangeDetection = useCallback(
    (updates: Partial<typeof cd>) => {
      if (!onAnnotationChange) {
        return;
      }
      const newCd = { ...cd, ...updates };
      const sql = generateChangeDetectionSQL(newCd);
      onAnnotationChange({
        ...anno,
        preset: 'change_detection',
        changeDetection: newCd,
        target: {
          ...(anno.target || {}),
          editorType: EditorType.SQL,
          rawSql: sql,
          refId: anno.target?.refId || 'annotation',
        },
      });
    },
    [anno, cd, onAnnotationChange]
  );

  const onSchemaChange = useCallback(
    (schemaValue: SchemaPickerValue) => {
      updateChangeDetection(schemaValue);
    },
    [updateChangeDetection]
  );

  const onPresetChange = useCallback(
    (value: AnnotationPreset) => {
      if (!onAnnotationChange) {
        return;
      }
      let sql = '';
      if (value === 'k8s_events') {
        sql = generateK8sEventsSQL(datasource.getDefaultDatabase?.() || '');
      } else if (value === 'change_detection') {
        sql = generateChangeDetectionSQL(cd);
      }
      onAnnotationChange({
        ...anno,
        preset: value,
        target: {
          ...(anno.target || {}),
          editorType: EditorType.SQL,
          rawSql: sql || anno.target?.rawSql || '',
          refId: anno.target?.refId || 'annotation',
        },
      });
    },
    [anno, cd, onAnnotationChange, datasource]
  );

  const onSqlChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (!onAnnotationChange) {
        return;
      }
      onAnnotationChange({
        ...anno,
        target: {
          ...(anno.target || {}),
          rawSql: e.currentTarget.value,
          editorType: EditorType.SQL,
          refId: anno.target?.refId || 'annotation',
        },
      });
    },
    [anno, onAnnotationChange]
  );

  const groupByOptions = [
    { label: 'ServiceName', value: 'ServiceName' },
    ...columns
      .filter((c) => !c.type?.startsWith('Map(') && c.name !== 'Timestamp' && c.name !== cd.column)
      .map((c) => ({ label: c.name, value: c.name })),
  ];

  return (
    <div>
      <div className="gf-form" style={{ marginBottom: 8 }}>
        <InlineFormLabel width={10} tooltip="Select an annotation preset or write custom SQL">
          Annotation Type
        </InlineFormLabel>
        <Select
          width={40}
          options={PRESET_OPTIONS}
          value={preset}
          onChange={(v) => onPresetChange(v.value || 'custom')}
        />
      </div>

      {preset === 'change_detection' && (
        <>
          <SchemaPicker
            datasource={datasource}
            value={cd}
            onChange={onSchemaChange}
            level="mapKey"
            labels={{ column: 'Watch Column', mapKey: 'Map Key' }}
          />

          {cd.column && (
            <div className="gf-form" style={{ marginBottom: 4 }}>
              <InlineFormLabel width={10} tooltip="Group changes by this column. Each unique value is tracked independently.">
                Group By
              </InlineFormLabel>
              <Select
                width={30}
                options={groupByOptions}
                value={cd.groupBy || 'ServiceName'}
                onChange={(v) => updateChangeDetection({ groupBy: v.value || 'ServiceName' })}
              />
            </div>
          )}
        </>
      )}

      <div className="gf-form" style={{ marginBottom: 4 }}>
        <InlineFormLabel width={10}>SQL Query</InlineFormLabel>
        <TextArea
          className={styles.sqlInput}
          rows={8}
          value={anno.target?.rawSql || ''}
          onChange={onSqlChange}
          placeholder="SELECT Timestamp AS time, Body AS text, ServiceName AS tags FROM otel_logs WHERE $__timeFilter(Timestamp)"
        />
      </div>

      <div className={styles.helpText}>
        {preset === 'change_detection'
          ? 'Annotations appear when the watched value changes per group, including rollbacks.'
          : 'Return columns: time (required), text, title, tags. Standard Grafana annotation mapping.'}
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  sqlInput: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  helpText: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginLeft: 88,
    marginBottom: theme.spacing(1),
  }),
});

/**
 * Build the full AnnotationSupport object for CHDatasource
 */
export function createAnnotationSupport(datasource: Datasource): AnnotationSupport<CHQuery> {
  return {
    prepareAnnotation: (json: any) => {
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
      const defaultDb = datasource.getDefaultDatabase?.() || '';
      return {
        editorType: EditorType.SQL,
        rawSql: generateChangeDetectionSQL({
          database: defaultDb,
          table: 'otel_traces',
          column: 'ResourceAttributes',
          mapKey: 'service.version',
          groupBy: 'ServiceName',
        }),
        refId: 'annotation',
      };
    },

    QueryEditor: AnnotationQueryEditor as any,
  };
}
