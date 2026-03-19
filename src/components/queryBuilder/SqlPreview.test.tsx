import React from 'react';
import { render } from '@testing-library/react';
import { SqlPreview } from './SqlPreview';

describe('SqlPreview', () => {
  it('returns null for empty sql', () => {
    const result = render(<SqlPreview sql="" />);
    expect(result.container.firstChild).toBeNull();
  });

  it('renders SQL when provided', () => {
    const result = render(<SqlPreview sql="SELECT 1" />);
    expect(result.container.firstChild).not.toBeNull();
    expect(result.getByText('SELECT 1')).toBeTruthy();
    expect(result.getByText('Generated SQL')).toBeTruthy();
  });
});
