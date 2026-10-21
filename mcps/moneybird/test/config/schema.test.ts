import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_TOOLSETS,
  TOOLSETS,
  callerConfig,
  configFromEnv,
  permissionsFor,
  resolveToolsets
} from '../../src/config/schema.ts';

describe('resolveToolsets', () => {
  it('returns the defaults when nothing is configured', () => {
    expect(resolveToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
  });

  it('returns an explicit comma-separated list, in canonical order', () => {
    expect(resolveToolsets('reports,core')).toEqual(['core', 'reports']);
  });

  it('returns every toolset for "all"', () => {
    expect(resolveToolsets('all')).toEqual([...TOOLSETS]);
  });

  it('enables no full toolset for "none"', () => {
    expect(resolveToolsets('none')).toEqual([]);
  });

  it('subtracts a toolset from the defaults with a leading "-"', () => {
    const result = resolveToolsets('-banking');
    expect(result).toEqual(
      DEFAULT_TOOLSETS.filter((toolset) => toolset !== 'banking')
    );
  });

  it('throws a ConfigError naming an unknown toolset', () => {
    expect(() => resolveToolsets('not-a-toolset')).toThrow(
      /Unknown toolset "not-a-toolset"/
    );
  });

  it('throws a ConfigError for an unknown toolset being subtracted', () => {
    expect(() => resolveToolsets('-not-a-toolset')).toThrow(ConfigError);
  });
});

describe('configFromEnv', () => {
  const base = {};

  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false]
  ])('parses MONEYBIRD_ALLOW_WRITE=%s as %s', (raw, expected) => {
    const config = configFromEnv({ ...base, MONEYBIRD_ALLOW_WRITE: raw });
    expect(config.allowWrite).toBe(expected);
  });

  it('defaults booleans to false when unset', () => {
    const config = configFromEnv(base);
    expect(config.allowWrite).toBe(false);
    expect(config.allowDelete).toBe(false);
  });
});

describe('permissionsFor', () => {
  const config = (overrides: { allowWrite: boolean; allowDelete: boolean }) =>
    configFromEnv({
      MONEYBIRD_ALLOW_WRITE: String(overrides.allowWrite),
      MONEYBIRD_ALLOW_DELETE: String(overrides.allowDelete)
    });

  it('grants neither write nor destroy by default', () => {
    expect(
      permissionsFor(config({ allowWrite: false, allowDelete: false }))
    ).toEqual({
      write: false,
      destroy: false
    });
  });

  it('grants write but not destroy when only allowWrite is set', () => {
    expect(
      permissionsFor(config({ allowWrite: true, allowDelete: false }))
    ).toEqual({
      write: true,
      destroy: false
    });
  });

  it('does not grant destroy from allowDelete alone', () => {
    expect(
      permissionsFor(config({ allowWrite: false, allowDelete: true }))
    ).toEqual({
      write: false,
      destroy: false
    });
  });

  it('grants destroy only when both allowWrite and allowDelete are set', () => {
    expect(
      permissionsFor(config({ allowWrite: true, allowDelete: true }))
    ).toEqual({
      write: true,
      destroy: true
    });
  });
});

describe('callerConfig', () => {
  const defaults = configFromEnv({ MONEYBIRD_ADMINISTRATION_ID: '1' });

  it('keeps the server defaults without headers', () => {
    const { config, warnings } = callerConfig(defaults, new Headers());
    expect(config).toEqual(defaults);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['read', false, false],
    ['write', true, false],
    ['DELETE', true, true]
  ])('maps X-Moneybird-Access %s', (access, write, destroy) => {
    const { config } = callerConfig(
      defaults,
      new Headers({ 'x-moneybird-access': access })
    );
    expect(permissionsFor(config)).toEqual({ write, destroy });
  });

  it('takes toolsets and the default administration from headers', () => {
    const { config } = callerConfig(
      defaults,
      new Headers({
        'x-moneybird-toolsets': 'invoicing, core',
        'x-moneybird-administration': '42'
      })
    );
    expect(config.toolsets).toEqual(['core', 'invoicing']);
    expect(config.administrationId).toBe('42');
  });

  it('ignores bad values and reports them instead of failing', () => {
    const { config, warnings } = callerConfig(
      defaults,
      new Headers({
        'x-moneybird-access': 'admin',
        'x-moneybird-toolsets': 'nope'
      })
    );
    expect(config).toEqual(defaults);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toMatch(/admin.*nope/s);
  });

  it('does not change the defaults it was given', () => {
    callerConfig(defaults, new Headers({ 'x-moneybird-access': 'delete' }));
    expect(defaults.allowDelete).toBe(false);
  });
});
