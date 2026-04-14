import React from 'react';
import { InlineFormLabel, Select } from '@grafana/ui';
import { Datasource } from 'data/CHDatasource';
import useDatabases from 'hooks/useDatabases';
import useTables from 'hooks/useTables';
import useColumns from 'hooks/useColumns';
import useUniqueMapKeys from 'hooks/useUniqueMapKeys';
import { SelectableValue } from '@grafana/data';

/**
 * Which pickers to show. Each level cascades from the previous.
 * - 'database': only database picker
 * - 'table': database + table
 * - 'column': database + table + column
 * - 'mapKey': database + table + column + map key (when column type is Map)
 */
export type SchemaPickerLevel = 'database' | 'table' | 'column' | 'mapKey';

export interface SchemaPickerValue {
  database?: string;
  table?: string;
  column?: string;
  mapKey?: string;
}

interface SchemaPickerProps {
  datasource: Datasource;
  value: SchemaPickerValue;
  onChange: (value: SchemaPickerValue) => void;
  /** How deep the cascade goes. Defaults to 'column'. */
  level?: SchemaPickerLevel;
  /** Label width for InlineFormLabel. Defaults to 10. */
  labelWidth?: number;
  /** Select width. Defaults to 30. */
  selectWidth?: number;
  /** Custom labels for each picker row */
  labels?: {
    database?: string;
    table?: string;
    column?: string;
    mapKey?: string;
  };
  /** If true, show column type in description */
  showColumnType?: boolean;
}

const LEVEL_ORDER: SchemaPickerLevel[] = ['database', 'table', 'column', 'mapKey'];

function levelIndex(level: SchemaPickerLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

/**
 * Reusable cascading schema picker: Database -> Table -> Column -> Map Key
 *
 * Used by the variable editor, annotation editor, and filter popover
 * to provide guided schema navigation without duplicating fetch logic.
 */
export const SchemaPicker: React.FC<SchemaPickerProps> = ({
  datasource,
  value,
  onChange,
  level = 'column',
  labelWidth = 10,
  selectWidth = 30,
  labels = {},
  showColumnType = true,
}) => {
  const maxLevel = levelIndex(level);

  // Use the existing shared hooks — no duplicate fetch logic
  const databases = useDatabases(datasource);
  const tables = useTables(datasource, value.database || '');
  const columns = useColumns(datasource, value.database || '', value.table || '');

  const selectedCol = columns.find((c) => c.name === value.column);
  const isMapColumn = selectedCol?.type?.startsWith('Map(') || false;
  const mapKeys = useUniqueMapKeys(
    datasource,
    isMapColumn ? value.column || '' : '',
    value.database || '',
    value.table || ''
  );

  const handleChange = (field: keyof SchemaPickerValue, newValue: string) => {
    const updated = { ...value, [field]: newValue };
    // Clear downstream selections when an upstream value changes
    if (field === 'database') {
      updated.table = '';
      updated.column = '';
      updated.mapKey = '';
    } else if (field === 'table') {
      updated.column = '';
      updated.mapKey = '';
    } else if (field === 'column') {
      updated.mapKey = '';
    }
    onChange(updated);
  };

  return (
    <>
      {/* Database picker — always shown */}
      <div className="gf-form" style={{ marginBottom: 4 }}>
        <InlineFormLabel width={labelWidth}>{labels.database || 'Database'}</InlineFormLabel>
        <Select
          width={selectWidth}
          options={databases.map((d) => ({ label: d, value: d }))}
          value={value.database || null}
          onChange={(v: SelectableValue<string>) => handleChange('database', v.value || '')}
          isClearable
          placeholder="Select database"
        />
      </div>

      {/* Table picker — shown when database selected and level >= table */}
      {maxLevel >= 1 && value.database && (
        <div className="gf-form" style={{ marginBottom: 4 }}>
          <InlineFormLabel width={labelWidth}>{labels.table || 'Table'}</InlineFormLabel>
          <Select
            width={selectWidth}
            options={tables.map((t) => ({ label: t, value: t }))}
            value={value.table || null}
            onChange={(v: SelectableValue<string>) => handleChange('table', v.value || '')}
            isClearable
            placeholder="Select table"
          />
        </div>
      )}

      {/* Column picker — shown when table selected and level >= column */}
      {maxLevel >= 2 && value.table && (
        <div className="gf-form" style={{ marginBottom: 4 }}>
          <InlineFormLabel width={labelWidth}>{labels.column || 'Column'}</InlineFormLabel>
          <Select
            width={selectWidth}
            options={columns.map((c) => ({
              label: c.name,
              value: c.name,
              description: showColumnType ? c.type : undefined,
            }))}
            value={value.column || null}
            onChange={(v: SelectableValue<string>) => handleChange('column', v.value || '')}
            isClearable
            placeholder="Select column"
          />
        </div>
      )}

      {/* Map key picker — shown when column is Map type and level >= mapKey */}
      {maxLevel >= 3 && isMapColumn && value.column && (
        <div className="gf-form" style={{ marginBottom: 4 }}>
          <InlineFormLabel width={labelWidth}>{labels.mapKey || 'Map Key'}</InlineFormLabel>
          <Select
            width={selectWidth}
            options={mapKeys.map((k) => ({ label: k, value: k }))}
            value={value.mapKey || null}
            onChange={(v: SelectableValue<string>) => handleChange('mapKey', v.value || '')}
            isClearable
            placeholder="Select key"
          />
        </div>
      )}
    </>
  );
};
