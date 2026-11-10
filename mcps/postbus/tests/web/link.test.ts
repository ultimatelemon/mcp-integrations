import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import type { McpHttpServer } from '@ultimatelemon-eu/mcp-http';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { listAccounts } from '../../src/db/accounts.js';
import { closeDb, getDb } from '../../src/db/index.js';
import { MAX_LINK_ATTEMPTS } from '../../src/db/links.js';
import { createUser } from '../../src/db/users.js';
import { ImapSmtpProvider } from '../../src/providers/imap/provider.js';
import { startServer } from '../../src/server.js';
import { PostbusError, type User } from '../../src/types.js';

// No DNS in tests; the host checks themselves are covered in net.test.ts.
vi.mock('../../src/net.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/net.js')>()),
  assertMailHostAllowed: () => Promise.resolve()
}));

let http: McpHttpServer;
let base: string;
const verify = vi.spyOn(ImapSmtpProvider.prototype, 'verify');

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  http = await startServer({
    port: 0,
    host: '127.0.0.1',
    basePath: '/postbus'
  });
  base = `http://127.0.0.1:${http.port}/postbus`;
});

afterAll(async () => {
  await http.close();
  vi.restoreAllMocks();
});

let user: User;
let token: string;

beforeEach(() => {
  closeDb();
  getDb();
  verify.mockReset();
  ({ user, token } = createUser('linker'));
});

async function startLink(
  alias = 'work'
): Promise<{ text: string; path: string }> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
  );
  const result = await client.callTool({
    name: 'add_mail_account',
    arguments: { alias, email: 'me@gmail.com' }
  });
  await client.close();

  const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
  const path = /\/link\/[A-Za-z0-9_-]+/.exec(text)?.[0] ?? '';
  return { text, path };
}

function post(path: string, password: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ app_password: password })
  });
}

describe('linking a mailbox through a one-time link', () => {
  it('hands out a link instead of asking for the password', async () => {
    const { text, path } = await startLink();

    expect(path).not.toBe('');
    expect(text).toContain('https://myaccount.google.com/apppasswords');
    expect(listAccounts(user.id)).toEqual([]);
  });

  it('shows the form with strict headers', async () => {
    const { path } = await startLink();
    const res = await fetch(`${base}${path}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain(
      "default-src 'none'"
    );
    const html = await res.text();
    expect(html).toContain('<h1>Link "work"</h1>');
    expect(html).toContain('name="app_password"');
  });

  it('stores the mailbox after a working password, then stops working', async () => {
    verify.mockResolvedValue(undefined);
    const { path } = await startLink();

    const res = await post(path, 'abcd efgh ijkl mnop');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Mailbox linked');
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        imapHost: 'imap.gmail.com',
        password: 'abcd efgh ijkl mnop'
      })
    );
    expect(listAccounts(user.id).map((a) => a.alias)).toEqual(['work']);
    expect((await fetch(`${base}${path}`)).status).toBe(404);
  });

  it('lets a wrong password be retried until the attempts run out', async () => {
    verify.mockRejectedValue(
      new PostbusError('The mail server rejected the login.', undefined, 'auth')
    );
    const { path } = await startLink();

    for (let left = MAX_LINK_ATTEMPTS - 1; left > 0; left--) {
      const res = await post(path, 'wrong');
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(`${left} attempt`);
    }

    expect((await post(path, 'wrong')).status).toBe(404);
    expect(listAccounts(user.id)).toEqual([]);
  });

  it('does not spend an attempt on an empty password', async () => {
    const { path } = await startLink();

    expect((await post(path, '  ')).status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it('answers an unknown link like a used one', async () => {
    const res = await fetch(`${base}/link/${'x'.repeat(43)}`);

    expect(res.status).toBe(404);
    expect(await res.text()).toContain('This link no longer works');
  });

  it('only answers under the base path', async () => {
    const { path } = await startLink();
    const origin = base.replace(/\/postbus$/, '');

    expect((await fetch(`${origin}${path}`)).status).toBe(404);
  });
});
