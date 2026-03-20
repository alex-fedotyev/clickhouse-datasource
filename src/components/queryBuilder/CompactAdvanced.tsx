import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { useStyles2, Select, Input } from '@grafana/ui';
import { OrderByDirection, QueryBuilderOptions, TableColumn, OrderBy } from 'types/queryBuilder';

interface CompactAdvancedProps {
  builderOptions: QueryBuilderOptions;
  allColumns: readonly TableColumn[];
  onOrderByChange: (orderBy: OrderBy[]) => void;
  onLimitChange: (limit: number) => void;
}

const getStyles = (theme: GrafanaTheme2) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5)} 0;
    flex-wrap: wrap;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  label: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
  `,
});

export const CompactAdvanced = (props: CompactAdvancedProps) => {
  const { builderOptions, allColumns, onOrderByChange, onLimitChange } = props;
  const styles = useStyles2(getStyles);

  const orderBy = builderOptions.orderBy || [];
  const limit = builderOptions.limit || 1000;

  const columnOptions: Array<SelectableValue<string>> = allColumns.map((c) => ({
    label: c.label || c.name,
    value: c.name,
  }));

  const directionOptions: Array<SelectableValue<OrderByDirection>> = [
    { label: 'ASC', value: OrderByDirection.ASC },
    { label: 'DESC', value: OrderByDirection.DESC },
  ];

  const currentOrderCol = orderBy.length > 0 ? orderBy[0].name : undefined;
  const currentOrderDir = orderBy.length > 0 ? orderBy[0].dir : OrderByDirection.DESC;

  return (
    <div className={styles.row} data-testid="compact-advanced">
      <div className={styles.item}>
        <span className={styles.label}>Order by</span>
        <Select
          options={columnOptions}
          value={currentOrderCol}
          onChange={(v) => {
            if (v.value) {
              onOrderByChange([{ name: v.value, dir: currentOrderDir }]);
            }
          }}
          width={20}
          placeholder="Column..."
          isClearable
          menuPlacement="bottom"
        />
        <Select
          options={directionOptions}
          value={currentOrderDir}
          onChange={(v) => {
            if (currentOrderCol && v.value) {
              onOrderByChange([{ name: currentOrderCol, dir: v.value }]);
            }
          }}
          width={10}
          menuPlacement="bottom"
        />
      </div>

      <div className={styles.item}>
        <span className={styles.label}>Limit</span>
        <Input
          type="number"
          value={limit}
          width={10}
          onChange={(e) => {
            const val = parseInt(e.currentTarget.value, 10);
            if (!isNaN(val) && val > 0) {
              onLimitChange(val);
            }
          }}
        />
      </div>
    </div>
  );
};
