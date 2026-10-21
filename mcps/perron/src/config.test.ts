import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('requires NS_API_KEY', () => {
    expect(() => loadConfig({})).toThrow('NS_API_KEY');
  });

  it('treats empty optional values as unset', () => {
    const config = loadConfig({ NS_API_KEY: 'k', REDIS_URL: '', ICON_URL: '' });
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.ICON_URL).toBeUndefined();
    expect(config.PORT).toBe(3000);
  });

  it('accepts an https or data: icon and rejects anything else', () => {
    expect(
      loadConfig({ NS_API_KEY: 'k', ICON_URL: 'https://example.com/i.png' })
        .ICON_URL
    ).toBe('https://example.com/i.png');
    expect(
      loadConfig({ NS_API_KEY: 'k', ICON_URL: 'data:image/png;base64,AAAA' })
        .ICON_URL
    ).toMatch(/^data:/);
    expect(() => loadConfig({ NS_API_KEY: 'k', ICON_URL: 'logo' })).toThrow(
      'ICON_URL'
    );
  });
});
