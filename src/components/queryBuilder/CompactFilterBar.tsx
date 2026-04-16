import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Button, Tooltip } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { Filter, TableColumn } from 'types/queryBuilder';
import { FilterTagBar } from './FilterTagBar';
import { FilterPopover } from './FilterPopover';

interface CompactFilterBarProps {
  datasource: Datasource;
  database: string;
  table: string;
  filters: Filter[];
  allColumns: readonly TableColumn[];
  onFiltersChange: (filters: Filter[]) => void;
  /** Toggle advanced options (order by, limit) */
  onToggleAdvanced?: () => void;
  advancedOpen?: boolean;
  /** Switch to raw SQL editor */
  onSwitchToSql?: () => void;
}

const getStyles = (theme: GrafanaTheme2) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.25)} 0;
    min-height: 32px;
  `,
  filters: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  `,
  actions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    flex-shrink: 0;
    margin-left: auto;
  `,
});

/**
 * Filter pills + action buttons row. This is the common row shared by all signals.
 * Layout: [pill ×] [pill ×] [+ Add filter]  ...  [⚙] [🕐] [✏ SQL]
 */
export const CompactFilterBar = (props: CompactFilterBarProps) => {
  const {
    datasource, database, table, filters, allColumns, onFiltersChange,
    onToggleAdvanced, advancedOpen, onSwitchToSql,
  } = props;
  const styles = useStyles2(getStyles);
  const [showPopover, setShowPopover] = useState(false);

  const onRemoveFilter = (index: number) => {
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const onAddFilter = (filter: Filter) => {
    onFiltersChange([...filters, filter]);
  };

  return (
    <div data-testid="compact-filter-bar">
      <div className={styles.row}>
        <div className={styles.filters}>
          <FilterTagBar filters={filters} onRemoveFilter={onRemoveFilter} />
          <Button
            icon="plus"
            variant="secondary"
            size="sm"
            fill="text"
            onClick={() => setShowPopover(!showPopover)}
          >
            Add filter
          </Button>
        </div>

        <div className={styles.actions}>
          {onToggleAdvanced && (
            <Tooltip content={advancedOpen ? 'Hide advanced options' : 'Show advanced options'}>
              <Button
                icon="cog"
                aria-label={advancedOpen ? 'Hide advanced options' : 'Show advanced options'}
                variant="secondary"
                size="sm"
                fill={advancedOpen ? 'solid' : 'text'}
                onClick={onToggleAdvanced}
              />
            </Tooltip>
          )}
          <Tooltip content="Open query history (Ctrl+H in Explore)">
            <Button
              icon="history"
              aria-label="Open query history"
              variant="secondary"
              size="sm"
              fill="text"
              onClick={() => {
                const event = new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true });
                document.dispatchEvent(event);
              }}
            />
          </Tooltip>
          {onSwitchToSql && (
            <Tooltip content="Switch to SQL editor">
              <Button
                icon="pen"
                variant="secondary"
                size="sm"
                fill="text"
                onClick={onSwitchToSql}
              >
                SQL
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {showPopover && (
        <FilterPopover
          datasource={datasource}
          database={database}
          table={table}
          allColumns={allColumns}
          onAddFilter={onAddFilter}
          onClose={() => setShowPopover(false)}
        />
      )}
    </div>
  );
};
