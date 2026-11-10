import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { accountExists, listAccounts, removeAccount } from '../db/accounts.js';
import { createLinkRequest, LINK_TTL_MS } from '../db/links.js';
import { findPreset } from '../providers/imap/presets.js';
import { release } from '../providers/imap/connection.js';
import { MAX_ACCOUNTS_PER_USER, publicBaseUrl } from '../config.js';
import { assertMailHostAllowed, isLoopbackHost } from '../net.js';
import { PostbusError } from '../types.js';
import type { ToolContext } from './context.js';
import { formatAccounts } from './format.js';
import { guard } from './guard.js';

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function registerAccountTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List your mailboxes',
      description:
        'Lists the mailboxes linked to your token, with alias and email address. ' +
        'Pass an alias as `account` to the other tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      guard('list_accounts', context.user, () =>
        Promise.resolve(formatAccounts(listAccounts(context.user.id)))
      )
  );

  server.registerTool(
    'add_mail_account',
    {
      title: 'Link a mailbox',
      description:
        'Starts linking an IMAP/SMTP mailbox and returns a one-time link. The user opens it ' +
        'and enters an app password there; the connection is tested before anything is stored. ' +
        'Never ask for a password in the chat and never pass one to this tool. ' +
        'For known providers (Gmail, Outlook, Fastmail, iCloud, Yahoo, Zoho) only alias and ' +
        'email are needed; host and port are filled in automatically.',
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .describe('Short name for this mailbox, e.g. "personal" or "work".'),
        email: z.string().min(3).describe('The email address of the mailbox.'),
        imap_host: z
          .string()
          .optional()
          .describe('IMAP host, e.g. imap.gmail.com.'),
        imap_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('IMAP port, usually 993.'),
        smtp_host: z
          .string()
          .optional()
          .describe('SMTP host, e.g. smtp.gmail.com.'),
        smtp_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('SMTP port: 465 (TLS) or 587 (STARTTLS).'),
        imap_secure: z
          .boolean()
          .optional()
          .describe(
            'Implicit TLS on the IMAP port. Defaults to on for port 993, off (STARTTLS) otherwise.'
          ),
        smtp_secure: z
          .boolean()
          .optional()
          .describe(
            'Implicit TLS on the SMTP port. Defaults to on for port 465, off (STARTTLS) otherwise.'
          ),
        username: z
          .string()
          .optional()
          .describe('Login name, if it differs from the email address.'),
        display_name: z
          .string()
          .optional()
          .describe('Sender name shown on outgoing mail.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    (input) =>
      guard('add_mail_account', context.user, async () => {
        const alias = input.alias.trim();
        if (!ALIAS_PATTERN.test(alias)) {
          throw new PostbusError(
            `Invalid alias "${alias}".`,
            'Use letters, digits, dot, dash or underscore (32 characters max).'
          );
        }

        const settings = resolveSettings(input);
        await assertMailTargetAllowed(settings);
        assertRoomForMailbox(context.user.id, alias);

        const email = input.email.trim();
        const { token } = createLinkRequest({
          userId: context.user.id,
          alias,
          email,
          displayName: input.display_name?.trim() || undefined,
          username: input.username?.trim() || email,
          ...settings
        });

        const appPasswordUrl = findPreset(email)?.appPasswordUrl;
        return [
          `To finish linking "${alias}" (${email}), the user opens this link and enters an app password there:`,
          '',
          `${publicBaseUrl()}/link/${token}`,
          '',
          `The link works once and expires in ${LINK_TTL_MS / 60_000} minutes. Do not ask for the password in the chat.`,
          appPasswordUrl
            ? `An app password is created at ${appPasswordUrl}.`
            : 'The app password comes from the mail provider; never the normal account password.',
          'When the page says the mailbox is linked, call list_accounts to confirm.'
        ].join('\n');
      })
  );

  server.registerTool(
    'remove_mail_account',
    {
      title: 'Unlink a mailbox',
      description:
        'Removes one of your mailboxes from postbus-mcp, including the stored app password. ' +
        'Nothing changes in the mailbox itself.',
      inputSchema: {
        alias: z.string().min(1).describe('Alias of the mailbox to unlink.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    ({ alias }) =>
      guard('remove_mail_account', context.user, async () => {
        const removedId = removeAccount(context.user.id, alias);
        if (!removedId) {
          const known = listAccounts(context.user.id).map((a) => a.alias);
          throw new PostbusError(
            `You have no mailbox with alias "${alias}".`,
            known.length ? `Available: ${known.join(', ')}.` : undefined
          );
        }

        await release(removedId);
        return `Mailbox "${alias}" is unlinked and its stored app password is gone.`;
      })
  );
}

export function assertRoomForMailbox(userId: string, alias: string): void {
  if (accountExists(userId, alias)) return;
  if (listAccounts(userId).length < MAX_ACCOUNTS_PER_USER) return;

  throw new PostbusError(
    `You already have the maximum of ${MAX_ACCOUNTS_PER_USER} linked mailboxes.`,
    'Unlink one with remove_mail_account first.',
    'invalid_input'
  );
}

// Host and port come straight from the caller, so without this the tool is a
// port scanner for whatever network the container sits in: aim it at an
// internal range and read the topology off the connection errors.
const PUBLIC_IMAP_PORTS = new Set([143, 993]);
const PUBLIC_SMTP_PORTS = new Set([25, 465, 587, 2525]);

export async function assertMailTargetAllowed(settings: {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}): Promise<void> {
  await assertMailHostAllowed(settings.imapHost);
  await assertMailHostAllowed(settings.smtpHost);

  assertPort('IMAP', settings.imapHost, settings.imapPort, PUBLIC_IMAP_PORTS);
  assertPort('SMTP', settings.smtpHost, settings.smtpPort, PUBLIC_SMTP_PORTS);
}

// A local bridge picks its own ports (Proton Mail Bridge uses 1143 and 1025),
// so only public hosts are held to the standard ones.
function assertPort(
  protocol: string,
  host: string,
  port: number,
  allowed: Set<number>
): void {
  if (isLoopbackHost(host) || allowed.has(port)) return;

  throw new PostbusError(
    `Port ${port} is not a ${protocol} port.`,
    `Use one of: ${[...allowed].join(', ')}.`,
    'invalid_input'
  );
}

export interface SettingsInput {
  email: string;
  imap_host?: string | undefined;
  imap_port?: number | undefined;
  imap_secure?: boolean | undefined;
  smtp_host?: string | undefined;
  smtp_port?: number | undefined;
  smtp_secure?: boolean | undefined;
}

const IMPLICIT_TLS_IMAP_PORT = 993;
const IMPLICIT_TLS_SMTP_PORT = 465;

export function resolveSettings(input: SettingsInput): {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
} {
  const preset = findPreset(input.email);

  const imapHost = input.imap_host?.trim() || preset?.imapHost;
  const smtpHost = input.smtp_host?.trim() || preset?.smtpHost;

  if (!imapHost || !smtpHost) {
    throw new PostbusError(
      `I do not know the mail server for "${input.email}".`,
      "Pass imap_host and smtp_host explicitly. Your provider lists them under 'IMAP settings', " +
        'typically imap.yourdomain.com (port 993) and smtp.yourdomain.com (port 465 or 587).'
    );
  }

  const imapPort =
    input.imap_port ?? preset?.imapPort ?? IMPLICIT_TLS_IMAP_PORT;
  const smtpPort =
    input.smtp_port ?? preset?.smtpPort ?? IMPLICIT_TLS_SMTP_PORT;

  return {
    imapHost,
    imapPort,
    // Implicit TLS on the standard ports; elsewhere imapflow and nodemailer
    // still negotiate STARTTLS when the server offers it.
    imapSecure: input.imap_secure ?? imapPort === IMPLICIT_TLS_IMAP_PORT,
    smtpHost,
    smtpPort,
    smtpSecure: input.smtp_secure ?? smtpPort === IMPLICIT_TLS_SMTP_PORT
  };
}
