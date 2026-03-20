import React, { useState, useEffect, useCallback } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { useStyles2, Select, Button, AsyncSelect } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import { Filter, FilterOperator, StringFilter, TableColumn } from 'types/queryBuilder';

interface FilterPopoverProps {
  datasource: Datasource;
  database: string;
  table: string;
  allColumns: readonly TableColumn[];
  onAddFilter: (filter: Filter) => void;
  onClose: () => void;
}

const operatorOptions: Array<SelectableValue<FilterOperator>> = [
  { label: '=', value: FilterOperator.Equals },
  { label: '!=', value: FilterOperator.NotEquals },
  { label: 'LIKE', value: FilterOperator.Like },
  { label: 'NOT LIKE', value: FilterOperator.NotLike },
  { label: 'IS NULL', value: FilterOperator.IsNull },
  { label: 'IS NOT NULL', value: FilterOperator.IsNotNull },
  { label: 'IN', value: FilterOperator.In },
  { label: 'NOT IN', value: FilterOperator.NotIn },
];

const getStyles = (theme: GrafanaTheme2) => ({
  popover: css`
    display: flex;
    align-items: flex-end;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(0.75)} 0;
    flex-wrap: wrap;
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  fieldLabel: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
  `,
});

export const FilterPopover = (props: FilterPopoverProps) => {
  const { datasource, database, table, allColumns, onAddFilter, onClose } = props;
  const styles = useStyles2(getStyles);

  const [selectedColumn, setSelectedColumn] = useState<string>('');
  const [selectedMapKey, setSelectedMapKey] = useState<string>('');
  const [operator, setOperator] = useState<FilterOperator>(FilterOperator.Equals);
  const [value, setValue] = useState<string>('');

  const selectedColDef = allColumns.find((c) => c.name === selectedColumn);
  const isMapColumn = selectedColDef?.type?.startsWith('Map(') || false;
  const [mapKeys, setMapKeys] = useState<string[]>([]);

  useEffect(() => {
    if (isMapColumn && selectedColumn && database && table) {
      datasource.fetchUniqueMapKeys(selectedColumn, database, table).then(setMapKeys).catch(() => setMapKeys([]));
    } else {
      setMapKeys([]);
      setSelectedMapKey('');
    }
  }, [datasource, database, table, selectedColumn, isMapColumn]);

  const columnOptions: Array<SelectableValue<string>> = allColumns.map((c) => ({
    label: c.label || c.name,
    value: c.name,
    description: c.type,
  }));

  const loadValueOptions = useCallback(async (inputValue: string): Promise<Array<SelectableValue<string>>> => {
    if (!selectedColumn || !database || !table) {
      return [];
    }
    try {
      let values: string[];
      if (isMapColumn && selectedMapKey) {
        values = await datasource.fetchDistinctMapValues(selectedColumn, selectedMapKey, database, table);
      } else if (!isMapColumn) {
        values = await datasource.fetchDistinctValues(selectedColumn, database, table);
      } else {
        return [];
      }
      return values
        .filter((v) => !inputValue || v.toLowerCase().includes(inputValue.toLowerCase()))
        .map((v) => ({ label: v, value: v }));
    } catch (err) {
      console.error('FilterPopover: failed to load values for column', selectedColumn, err);
      return [];
    }
  }, [datasource, database, table, selectedColumn, isMapColumn, selectedMapKey]);

  const noValueNeeded = operator === FilterOperator.IsNull || operator === FilterOperator.IsNotNull;

  const handleAdd = () => {
    if (!selectedColumn) {
      return;
    }

    const colType = selectedColDef?.type || 'string';
    const filter: StringFilter = {
      filterType: 'custom',
      key: selectedColumn,
      type: colType,
      operator: operator as any,
      value: noValueNeeded ? '' : value,
      condition: 'AND',
      ...(isMapColumn && selectedMapKey ? { mapKey: selectedMapKey } : {}),
    };
    onAddFilter(filter as Filter);
    onClose();
  };

  return (
    <div className={styles.popover} data-testid="filter-popover">
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Column</span>
        <Select
          options={columnOptions}
          value={selectedColumn}
          onChange={(v) => {
            setSelectedColumn(v.value || '');
            setSelectedMapKey('');
            setValue('');
          }}
          width={24}
          placeholder="Select column..."
          menuPlacement="bottom"
        />
      </div>

      {isMapColumn && (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Map key</span>
          <Select
            options={mapKeys.map((k) => ({ label: k, value: k }))}
            value={selectedMapKey}
            onChange={(v) => {
              setSelectedMapKey(v.value || '');
              setValue('');
            }}
            width={20}
            placeholder="Select key..."
            menuPlacement="bottom"
          />
        </div>
      )}

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Operator</span>
        <Select
          options={operatorOptions}
          value={operator}
          onChange={(v) => setOperator(v.value || FilterOperator.Equals)}
          width={14}
          menuPlacement="bottom"
        />
      </div>

      {!noValueNeeded && (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Value</span>
          <AsyncSelect
            key={`${selectedColumn}-${selectedMapKey}`}
            loadOptions={loadValueOptions}
            defaultOptions={Boolean(selectedColumn)}
            value={value ? { label: value, value } : undefined}
            onChange={(v) => setValue(v?.value || '')}
            allowCustomValue
            onCreateOption={(v) => setValue(v)}
            width={24}
            placeholder="Type or select..."
            menuPlacement="bottom"
          />
        </div>
      )}

      <div className={styles.actions}>
        <Button size="sm" onClick={handleAdd} disabled={!selectedColumn}>
          Add
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
};
