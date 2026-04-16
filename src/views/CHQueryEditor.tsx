import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QueryEditorProps } from '@grafana/data';
import { Datasource } from 'data/CHDatasource';
import { EditorTypeSwitcher } from 'components/queryBuilder/EditorTypeSwitcher';
import { styles } from 'styles';
import { Button, ConfirmModal, Tooltip } from '@grafana/ui';
import { CHBuilderQuery, CHQuery, EditorType } from 'types/sql';
import { CHConfig } from 'types/config';
import { QueryBuilder } from 'components/queryBuilder/QueryBuilder';
import { generateSql } from 'data/sqlGenerator';
import { SqlEditor } from 'components/SqlEditor';
import { isBuilderOptionsRunnable, mapQueryBuilderOptionsToGrafanaFormat } from 'data/utils';
import { setAllOptions, useBuilderOptionsState } from 'hooks/useBuilderOptionsState';
import { pluginVersion } from 'utils/version';
import { migrateCHQuery } from 'data/migration';

export type CHQueryEditorProps = QueryEditorProps<Datasource, CHQuery, CHConfig>;

/**
 * Top level query editor component
 */
export const CHQueryEditor = (props: CHQueryEditorProps) => {
  const { datasource, query: savedQuery, onRunQuery } = props;
  const query = migrateCHQuery(savedQuery);
  const singleTableMode = datasource.isSingleTableMode();

  // In single-table mode: compact layout for both builder and SQL
  if (singleTableMode) {
    if (query.editorType === EditorType.SQL) {
      // Compact SQL mode — minimal header, no QueryTypeSwitcher/EditorTypeSwitcher
      return (
        <CompactSqlMode
          {...props}
          query={query}
        />
      );
    }
    // Builder mode — CompactModeBar handles the header
    return <CHEditorByType {...props} query={query} />;
  }

  // Classic mode: full EditorTypeSwitcher + Run button
  return (
    <>
      <div className={'gf-form ' + styles.QueryEditor.queryType}>
        <EditorTypeSwitcher {...props} query={query} datasource={datasource} />
        <Button onClick={() => onRunQuery()}>Run Query</Button>
      </div>
      <CHEditorByType {...props} query={query} />
    </>
  );
};

const CHEditorByType = (props: CHQueryEditorProps) => {
  const { query, onChange, app } = props;
  const [builderOptions, builderOptionsDispatch] = useBuilderOptionsState((query as CHBuilderQuery).builderOptions);

  /**
   * Grafana will sometimes replace the builder options directly, so we need to sync in both directions.
   * For example, selecting an entry from the query history will cause the local state to fall out of sync.
   * The "key" property is present on these historical entries.
   */
  const queryKey = query.key || '';
  const lastKey = useRef<string>(queryKey);
  if (queryKey !== lastKey.current && query.editorType === EditorType.Builder) {
    builderOptionsDispatch(setAllOptions((query as CHBuilderQuery).builderOptions || {}));
    lastKey.current = queryKey;
  }

  /**
   * Sync builder options when switching from SQL Editor to Query Builder
   */
  const lastEditorType = useRef<EditorType | undefined>(undefined);
  if (query.editorType !== lastEditorType.current && query.editorType === EditorType.Builder) {
    builderOptionsDispatch(setAllOptions((query as CHBuilderQuery).builderOptions || {}));
  }
  lastEditorType.current = query.editorType;

  // Prevent trying to run empty query on load, or stale query after datasource switch
  const signalType = props.datasource.getSignalType();
  const singleTable = props.datasource.isSingleTableMode();
  const shouldSkipChanges = useRef<boolean>(true);
  if (isBuilderOptionsRunnable(builderOptions)) {
    // In single-table mode, only allow onChange when queryType matches the configured signal
    if (singleTable && signalType) {
      const expectedType = signalType === 'logs' ? 'logs' : signalType === 'traces' ? 'traces' : signalType === 'metrics' ? 'timeseries' : undefined;
      shouldSkipChanges.current = builderOptions.queryType !== expectedType;
    } else {
      shouldSkipChanges.current = false;
    }
  }

  useEffect(() => {
    if (shouldSkipChanges.current || query.editorType === EditorType.SQL) {
      return;
    }

    onChange({
      ...query,
      pluginVersion,
      editorType: EditorType.Builder,
      rawSql: generateSql(builderOptions),
      builderOptions,
      format: mapQueryBuilderOptionsToGrafanaFormat(builderOptions),
    });

    // TODO: fix dependency warning with "useEffectEvent" once added to stable version of react
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderOptions]);

  const onSwitchToSql = useCallback(() => {
    onChange({
      ...query,
      editorType: EditorType.SQL,
      rawSql: generateSql(builderOptions),
      queryType: builderOptions.queryType,
      format: mapQueryBuilderOptionsToGrafanaFormat(builderOptions),
      meta: { builderOptions },
    } as CHQuery);
  }, [onChange, query, builderOptions]);

  // Direct query change bypass — used by CompactQueryEditor to avoid stale-query race on ds switch
  const onQueryChange = useCallback((newOptions: import('types/queryBuilder').QueryBuilderOptions) => {
    onChange({
      ...query,
      pluginVersion,
      editorType: EditorType.Builder,
      rawSql: generateSql(newOptions),
      builderOptions: newOptions,
      format: mapQueryBuilderOptionsToGrafanaFormat(newOptions),
    });
  }, [onChange, query]);

  if (query.editorType === EditorType.SQL) {
    return (
      <div data-testid="query-editor-section-sql">
        <SqlEditor {...props} />
      </div>
    );
  }

  return (
    <QueryBuilder
      datasource={props.datasource}
      builderOptions={builderOptions}
      builderOptionsDispatch={builderOptionsDispatch}
      onQueryChange={onQueryChange}
      generatedSql={query.rawSql}
      app={app}
      onSwitchToSql={onSwitchToSql}
    />
  );
};

/**
 * Compact SQL mode for single-table datasources.
 * Renders the SqlEditor without QueryTypeSwitcher/EditorTypeSwitcher,
 * with a simple "Back to Query Builder" button that resets the query.
 */
const CompactSqlMode = (props: CHQueryEditorProps) => {
  const { query, onChange, onRunQuery } = props;
  const [showConfirm, setShowConfirm] = useState(false);

  const onSwitchToBuilder = () => {
    // Reset to empty builder state — CompactQueryEditor will reinitialize from OTEL config
    onChange({
      ...query,
      editorType: EditorType.Builder,
      rawSql: '',
      builderOptions: {
        database: '',
        table: '',
        queryType: 0 as any,
        mode: 0 as any,
        columns: [],
        filters: [],
      },
    } as CHQuery);
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
        <Tooltip content="Switch back to query builder (query will reset)">
          <Button
            icon="arrow-left"
            variant="secondary"
            size="sm"
            fill="text"
            onClick={() => setShowConfirm(true)}
          >
            Query Builder
          </Button>
        </Tooltip>
      </div>
      <div data-testid="query-editor-section-sql">
        <SqlEditor {...props} compact />
      </div>
      <ConfirmModal
        isOpen={showConfirm}
        title="Switch to Query Builder?"
        body="The current SQL cannot be converted back to the visual builder. Switching will start a new query for the configured signal type."
        confirmText="Switch to Builder"
        dismissText="Stay in SQL"
        icon="exclamation-triangle"
        onConfirm={() => {
          setShowConfirm(false);
          onSwitchToBuilder();
        }}
        onDismiss={() => setShowConfirm(false)}
      />
    </>
  );
};
