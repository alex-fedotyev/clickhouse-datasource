import { useState, useEffect, useCallback } from 'react';
import { Datasource } from 'data/CHDatasource';

interface UseDistinctValuesOptions {
  datasource: Datasource;
  database: string;
  table: string;
  column: string;
  mapKey?: string;
  enabled?: boolean;
}

export const useDistinctValues = (opts: UseDistinctValuesOptions) => {
  const { datasource, database, table, column, mapKey, enabled = true } = opts;
  const [values, setValues] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!enabled || !datasource || !database || !table || !column) {
      return;
    }

    setLoading(true);
    try {
      let result: string[];
      if (mapKey) {
        result = await datasource.fetchDistinctMapValues(column, mapKey, database, table);
      } else {
        result = await datasource.fetchDistinctValues(column, database, table);
      }
      setValues(result);
    } catch (err) {
      console.error('Failed to fetch distinct values:', err);
      setValues([]);
    } finally {
      setLoading(false);
    }
  }, [datasource, database, table, column, mapKey, enabled]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { values, loading, refetch: fetch };
};
