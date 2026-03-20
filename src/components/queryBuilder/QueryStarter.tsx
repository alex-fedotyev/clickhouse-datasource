import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { QueryType, BuilderMode, ColumnHint, FilterOperator, DateFilterWithoutValue } from 'types/queryBuilder';
import {
  BuilderOptionsReducerAction,
  setAllOptions,
} from 'hooks/useBuilderOptionsState';
import otel from 'otel';

interface QueryStarterProps {
  datasource: Datasource;
  builderOptionsDispatch: React.Dispatch<BuilderOptionsReducerAction>;
}

interface QuickAction {
  icon: string;
  title: string;
  description: string;
  onClick: () => void;
  accent?: string;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(2)} ${theme.spacing(1)};
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(2)};
  `,
  card: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(1.5)};
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    cursor: pointer;
    transition: all 0.15s ease;
    &:hover {
      border-color: ${theme.colors.primary.border};
      background: ${theme.colors.background.secondary};
      box-shadow: ${theme.shadows.z1};
    }
  `,
  cardIcon: css`
    flex-shrink: 0;
    margin-top: 2px;
  `,
  cardContent: css`
    flex: 1;
    min-width: 0;
  `,
  cardTitle: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.primary};
    margin-bottom: 2px;
  `,
  cardDesc: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    line-height: 1.3;
  `,
  sectionLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: ${theme.spacing(1)};
  `,
  otelSection: css`
    margin-top: ${theme.spacing(1.5)};
    padding-top: ${theme.spacing(1.5)};
    border-top: 1px solid ${theme.colors.border.weak};
  `,
  otelBadge: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.success.text};
    background: ${theme.colors.success.transparent};
    padding: 2px 6px;
    border-radius: ${theme.shape.radius.pill};
    margin-left: ${theme.spacing(0.5)};
  `,
});

export const QueryStarter = (props: QueryStarterProps) => {
  const { datasource, builderOptionsDispatch } = props;
  const styles = useStyles2(getStyles);

  const logsOtelVersion = datasource.getLogsOtelVersion();
  const traceOtelVersion = datasource.getTraceOtelVersion();
  const hasOtelLogs = Boolean(logsOtelVersion);
  const hasOtelTraces = Boolean(traceOtelVersion);
  const hasOtel = hasOtelLogs || hasOtelTraces;

  const defaultDb = datasource.getDefaultDatabase() || '';
  const logsDb = datasource.getDefaultLogsDatabase() || defaultDb;
  const logsTable = datasource.getDefaultLogsTable() || '';
  const tracesDb = datasource.getDefaultTraceDatabase() || defaultDb;
  const tracesTable = datasource.getDefaultTraceTable() || '';

  const startQuery = (queryType: QueryType, database: string, table: string, mode?: BuilderMode) => {
    const otelVersion = queryType === QueryType.Logs ? logsOtelVersion : traceOtelVersion;
    const otelConfig = otelVersion ? otel.getVersion(otelVersion) : undefined;
    const columnMap = queryType === QueryType.Logs ? otelConfig?.logColumnMap : otelConfig?.traceColumnMap;
    const columns = columnMap ? Array.from(columnMap, ([hint, name]) => ({ name, hint })) : [];

    // Add default time range filter so queries include WHERE $__timeFilter
    const timeHint = queryType === QueryType.Logs ? ColumnHint.FilterTime : ColumnHint.Time;
    const defaultFilters = [{
      type: 'datetime',
      operator: FilterOperator.WithInGrafanaTimeRange,
      filterType: 'custom',
      key: '',
      hint: timeHint,
      condition: 'AND',
    } as DateFilterWithoutValue];

    builderOptionsDispatch(setAllOptions({
      database: database || defaultDb,
      table,
      queryType,
      mode: mode || (queryType === QueryType.Logs ? BuilderMode.List : undefined),
      columns,
      filters: defaultFilters,
      orderBy: [],
      meta: {
        otelEnabled: Boolean(otelVersion),
        otelVersion: otelVersion || undefined,
        traceDurationUnit: queryType === QueryType.Traces ? otelConfig?.traceDurationUnit : undefined,
        flattenNested: otelConfig?.flattenNested,
        traceEventsColumnPrefix: otelConfig?.traceEventsColumnPrefix,
        traceLinksColumnPrefix: otelConfig?.traceLinksColumnPrefix,
      },
    }));
  };

  const generalActions: QuickAction[] = [
    {
      icon: 'table',
      title: 'Explore a Table',
      description: 'Browse columns, filter, and sort',
      onClick: () => startQuery(QueryType.Table, defaultDb, ''),
    },
    {
      icon: 'gf-logs',
      title: 'Search Logs',
      description: 'Full-text search with filters',
      onClick: () => startQuery(QueryType.Logs, logsDb, logsTable),
    },
    {
      icon: 'gf-traces',
      title: 'Search Traces',
      description: 'Find traces by service or error',
      onClick: () => startQuery(QueryType.Traces, tracesDb, tracesTable),
    },
    {
      icon: 'graph-bar',
      title: 'Build a Metric',
      description: 'Time series with aggregation',
      onClick: () => startQuery(QueryType.TimeSeries, defaultDb, ''),
    },
  ];

  const otelActions: QuickAction[] = [];
  if (hasOtelLogs && logsTable) {
    otelActions.push({
      icon: 'gf-logs',
      title: 'OTEL Logs',
      description: `${logsTable} — ready to query`,
      onClick: () => startQuery(QueryType.Logs, logsDb, logsTable),
    });
  }
  if (hasOtelTraces && tracesTable) {
    otelActions.push({
      icon: 'gf-traces',
      title: 'OTEL Traces',
      description: `${tracesTable} — ready to query`,
      onClick: () => startQuery(QueryType.Traces, tracesDb, tracesTable),
    });
  }

  return (
    <div className={styles.container} data-testid="query-starter">
      <div className={styles.sectionLabel}>What would you like to query?</div>
      <div className={styles.grid}>
        {generalActions.map((action) => (
          <div key={action.title} className={styles.card} onClick={action.onClick} role="button" tabIndex={0}>
            <Icon name={action.icon as any} size="lg" className={styles.cardIcon} />
            <div className={styles.cardContent}>
              <div className={styles.cardTitle}>{action.title}</div>
              <div className={styles.cardDesc}>{action.description}</div>
            </div>
          </div>
        ))}
      </div>

      {hasOtel && otelActions.length > 0 && (
        <div className={styles.otelSection}>
          <div className={styles.sectionLabel}>
            Quick Start
            <span className={styles.otelBadge}>
              <Icon name="check-circle" size="xs" /> OTEL detected
            </span>
          </div>
          <div className={styles.grid}>
            {otelActions.map((action) => (
              <div key={action.title} className={styles.card} onClick={action.onClick} role="button" tabIndex={0}>
                <Icon name={action.icon as any} size="lg" className={styles.cardIcon} />
                <div className={styles.cardContent}>
                  <div className={styles.cardTitle}>{action.title}</div>
                  <div className={styles.cardDesc}>{action.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
