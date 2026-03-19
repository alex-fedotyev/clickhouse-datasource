import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, useStyles2, Tooltip, ClipboardButton } from '@grafana/ui';

interface SqlPreviewProps {
  sql: string;
  onSwitchToSql?: () => void;
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    margin-top: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    overflow: hidden;
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.primary};
  `,
  headerLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
  `,
  sqlBlock: css`
    padding: ${theme.spacing(1)};
    margin: 0;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    line-height: 1.5;
    color: ${theme.colors.text.primary};
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  `,
});

export const SqlPreview = (props: SqlPreviewProps) => {
  const { sql, onSwitchToSql } = props;
  const styles = useStyles2(getStyles);

  if (!sql) {
    return null;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Generated SQL</span>
        <div className={styles.actions}>
          <ClipboardButton
            icon="copy"
            variant="secondary"
            size="sm"
            fill="text"
            getText={() => sql}
          >
            Copy
          </ClipboardButton>
          {onSwitchToSql && (
            <Tooltip content="Switch to SQL editor with this query pre-filled">
              <Button
                icon="pen"
                variant="secondary"
                size="sm"
                fill="text"
                onClick={onSwitchToSql}
              >
                Edit as SQL
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      <pre className={styles.sqlBlock}>{sql}</pre>
    </div>
  );
};
