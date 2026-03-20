import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Button } from '@grafana/ui';
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
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    flex-wrap: wrap;
  `,
});

export const CompactFilterBar = (props: CompactFilterBarProps) => {
  const { datasource, database, table, filters, allColumns, onFiltersChange } = props;
  const styles = useStyles2(getStyles);
  const [showPopover, setShowPopover] = useState(false);

  const onRemoveFilter = (index: number) => {
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const onAddFilter = (filter: Filter) => {
    onFiltersChange([...filters, filter]);
  };

  return (
    <div className={styles.wrapper} data-testid="compact-filter-bar">
      <div className={styles.row}>
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
