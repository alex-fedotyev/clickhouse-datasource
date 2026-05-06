import React, { useState } from 'react';
import { Datasource } from 'data/CHDatasource';
import { SchemaPicker, SchemaPickerLevel, SchemaPickerValue } from './SchemaPicker';

/**
 * SCRATCH HARNESS — DO NOT MERGE. Renders SchemaPicker at each of the four
 * depth levels for a quick visual review in Grafana before opening PR1.
 */
export const SchemaPickerHarness = ({ datasource }: { datasource: Datasource }) => {
  const [databaseValue, setDatabaseValue] = useState<SchemaPickerValue>({});
  const [tableValue, setTableValue] = useState<SchemaPickerValue>({});
  const [columnValue, setColumnValue] = useState<SchemaPickerValue>({});
  const [mapKeyValue, setMapKeyValue] = useState<SchemaPickerValue>({});

  const sectionStyle: React.CSSProperties = {
    padding: '8px 0',
    margin: '8px 0',
    borderBottom: '1px solid rgba(204, 204, 220, 0.15)',
  };
  const headingStyle: React.CSSProperties = { margin: '0 0 8px 0', fontWeight: 600 };
  const stateStyle: React.CSSProperties = {
    margin: '4px 0 0 0',
    fontFamily: 'monospace',
    fontSize: '12px',
    opacity: 0.75,
  };

  const sections: Array<{ level: SchemaPickerLevel; label: string; value: SchemaPickerValue; setValue: (v: SchemaPickerValue) => void }> = [
    { level: 'database', label: "level='database'", value: databaseValue, setValue: setDatabaseValue },
    { level: 'table', label: "level='table'", value: tableValue, setValue: setTableValue },
    { level: 'column', label: "level='column'  (default)", value: columnValue, setValue: setColumnValue },
    { level: 'mapKey', label: "level='mapKey'  (Map column unlocks the 4th picker)", value: mapKeyValue, setValue: setMapKeyValue },
  ];

  return (
    <div style={{ padding: '12px', border: '1px dashed rgba(204, 204, 220, 0.3)', borderRadius: 4, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 12px 0' }}>SchemaPicker visual harness</h3>
      {sections.map((s) => (
        <div key={s.level} style={sectionStyle}>
          <p style={headingStyle}>{s.label}</p>
          <SchemaPicker datasource={datasource} level={s.level} value={s.value} onChange={s.setValue} />
          <p style={stateStyle}>state: {JSON.stringify(s.value)}</p>
        </div>
      ))}
    </div>
  );
};
