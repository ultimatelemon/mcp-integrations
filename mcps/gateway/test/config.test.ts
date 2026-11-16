import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  parseRoutesFile,
  resolveConfig
} from '../src/config.ts';
import { routesWithDummy, testEnv } from './support/fakes.ts';

const env = {
  PUBLIC_URL: 'https://mcp.ultimatelemon.eu/',
  ENCRYPTION_KEY: 'key',
  GATEWAY_OIDC_ISSUER: 'https://id.ultimatelemon.eu',
  GATEWAY_OIDC_CLIENT_ID: 'client',
  GATEWAY_OIDC_CLIENT_SECRET: 'secret',
  GATEWAY_OWNER_SUB: 'owner-sub',
  GARMIN_MCP_HTTP_TOKEN: 'garmin-token'
};

function routes(body: string): string {
  return `subjects:\n  owner: GATEWAY_OWNER_SUB\nroutes:\n${body}`;
}

describe('loadConfig', () => {
  it('reads the repository routes.yaml with its garmin route', () => {
    const config = loadConfig(env);
    expect(config.publicUrl).toBe('https://mcp.ultimatelemon.eu');
    expect(config.oidc).toEqual({
      issuer: 'https://id.ultimatelemon.eu',
      clientId: 'client',
      clientSecret: 'secret'
    });
    expect(config.routes).toHaveLength(1);
    const [garmin] = config.routes;
    expect(garmin).toMatchObject({
      key: 'garmin',
      path: '/garmin',
      name: 'Garmin',
      upstream: 'http://garmin-mcp:8000/mcp',
      upstreamToken: 'garmin-token'
    });
    expect([...(garmin?.allowedSubjects ?? [])]).toEqual(['owner-sub']);
  });

  it('lets <ROUTE>_UPSTREAM_URL override the upstream for local development', () => {
    const config = loadConfig({
      ...env,
      GARMIN_UPSTREAM_URL: 'http://localhost:8000/mcp'
    });
    expect(config.routes[0]?.upstream).toBe('http://localhost:8000/mcp');
  });

  it('refuses an override that is not an http URL', () => {
    expect(() =>
      loadConfig({ ...env, GARMIN_UPSTREAM_URL: 'file:///etc/passwd' })
    ).toThrow('GARMIN_UPSTREAM_URL must be an http(s) URL.');
  });

  it('names every missing variable at once', () => {
    expect(() => loadConfig({ GATEWAY_OWNER_SUB: '  ' })).toThrow(
      new ConfigError(
        'Missing environment variables: ENCRYPTION_KEY, GARMIN_MCP_HTTP_TOKEN, GATEWAY_OIDC_CLIENT_ID, GATEWAY_OIDC_CLIENT_SECRET, GATEWAY_OIDC_ISSUER, GATEWAY_OWNER_SUB, PUBLIC_URL'
      )
    );
  });

  it('asks for the env vars of a new route, and nothing else', () => {
    const file = parseRoutesFile(routesWithDummy());
    const full = testEnv('http://127.0.0.1:1');
    delete full['DUMMY_MCP_TOKEN'];
    delete full['GATEWAY_FRIEND_SUB'];
    expect(() => resolveConfig(file, full)).toThrow(
      'Missing environment variables: DUMMY_MCP_TOKEN, GATEWAY_FRIEND_SUB'
    );
  });
});

describe('parseRoutesFile', () => {
  const garmin = `  garmin:
    path: /garmin
    upstream: http://garmin-mcp:8000/mcp
    upstreamTokenEnv: GARMIN_MCP_HTTP_TOKEN
    name: Garmin
    allowedSubjects: [owner]
`;

  it('accepts a valid file', () => {
    expect(Object.keys(parseRoutesFile(routes(garmin)).routes)).toEqual([
      'garmin'
    ]);
  });

  it.each([
    [
      'an unknown subject',
      garmin.replace('[owner]', '[stranger]'),
      'unknown subjects stranger'
    ],
    [
      'a token value instead of an env var name',
      garmin.replace('GARMIN_MCP_HTTP_TOKEN', 'sk-live-123'),
      'routes.garmin.upstreamTokenEnv'
    ],
    [
      'a reserved path',
      garmin.replace('/garmin', '/healthz'),
      'routes.garmin.path: is reserved'
    ],
    ['a nested path', garmin.replace('/garmin', '/a/b'), 'routes.garmin.path'],
    [
      'a non-http upstream',
      garmin.replace('http://garmin-mcp:8000/mcp', 'ftp://garmin'),
      'routes.garmin.upstream'
    ],
    [
      'an unknown field',
      garmin.replace('name: Garmin', 'name: Garmin\n    token: abc'),
      'routes.garmin'
    ],
    [
      'no allowed subjects',
      garmin.replace('[owner]', '[]'),
      'routes.garmin.allowedSubjects'
    ],
    [
      'a path used twice',
      `${garmin}${garmin.replace('  garmin:', '  other:')}`,
      'path /garmin is used twice'
    ]
  ])('refuses %s', (_, body, message) => {
    expect(() => parseRoutesFile(routes(body))).toThrow(message);
  });

  it('refuses a file without routes', () => {
    expect(() => parseRoutesFile('subjects: {}\nroutes: {}\n')).toThrow(
      'The routes file has no routes.'
    );
  });
});
