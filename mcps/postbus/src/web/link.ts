import { escapeHtml, htmlPage, htmlResponse } from '@ultimatelemon-eu/mcp-http';
import { saveImapAccount } from '../db/accounts.js';
import {
  completeLinkRequest,
  findLinkRequest,
  MAX_LINK_ATTEMPTS,
  takeLinkAttempt,
  type LinkRequest
} from '../db/links.js';
import { logEvent } from '../log.js';
import { release } from '../providers/imap/connection.js';
import { findPreset } from '../providers/imap/presets.js';
import { ImapSmtpProvider } from '../providers/imap/provider.js';
import {
  assertMailTargetAllowed,
  assertRoomForMailbox
} from '../tools/accounts.js';
import { PostbusError, type ImapAccount } from '../types.js';

export function linkPages(
  basePath: string
): (request: Request) => Promise<Response | undefined> {
  const pattern = new RegExp(
    `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/link/([A-Za-z0-9_-]{16,128})$`
  );
  return (request) => handleLinkPage(request, pattern);
}

async function handleLinkPage(
  request: Request,
  pattern: RegExp
): Promise<Response | undefined> {
  const token = pattern.exec(new URL(request.url).pathname)?.[1];
  if (!token) return undefined;

  if (request.method !== 'GET' && request.method !== 'POST') {
    return htmlResponse(
      message('Not allowed', 'Open the link in your browser.'),
      405
    );
  }

  const link = findLinkRequest(token);
  if (!link) return gone();
  if (request.method === 'GET') return form(link);

  const password =
    new URLSearchParams(await request.text()).get('app_password') ?? '';
  if (!password.trim()) {
    return form(link, 'Enter the app password.', 400);
  }

  if (!takeLinkAttempt(link.id)) return gone();

  try {
    await storeMailbox(link, password);
  } catch (error) {
    logEvent({
      event: 'link',
      userId: link.userId,
      ok: false,
      error: error instanceof PostbusError ? error.kind : 'internal'
    });

    const left = MAX_LINK_ATTEMPTS - link.attempts - 1;
    if (left <= 0) return gone();
    return form(link, describe(error), 400, left);
  }

  completeLinkRequest(link.id);
  logEvent({ event: 'link', userId: link.userId, ok: true });

  return htmlResponse(
    message(
      'Mailbox linked',
      `"${link.alias}" (${link.email}) is linked and the app password is stored encrypted. ` +
        'You can close this page and go back to Claude.'
    ),
    200
  );
}

async function storeMailbox(
  link: LinkRequest,
  password: string
): Promise<void> {
  // Checked again: DNS can point the host somewhere else after the link was made.
  await assertMailTargetAllowed(link);
  assertRoomForMailbox(link.userId, link.alias);

  const candidate: ImapAccount = {
    id: `probe-${link.alias}`,
    userId: link.userId,
    alias: link.alias,
    email: link.email,
    displayName: link.displayName,
    createdAt: new Date().toISOString(),
    provider: 'imap',
    imapHost: link.imapHost,
    imapPort: link.imapPort,
    imapSecure: link.imapSecure,
    smtpHost: link.smtpHost,
    smtpPort: link.smtpPort,
    smtpSecure: link.smtpSecure,
    username: link.username,
    password
  };

  await new ImapSmtpProvider().verify(candidate);

  const saved = saveImapAccount({ ...candidate, userId: link.userId });

  // An upsert keeps the row id and the pool is keyed on it, so a relink would
  // otherwise keep serving the connection made with the old password.
  await release(saved.id);
}

function describe(error: unknown): string {
  if (!(error instanceof PostbusError)) {
    return 'Something went wrong while testing the connection. Try again.';
  }
  return error.hint ? `${error.message} ${error.hint}` : error.message;
}

function form(
  link: LinkRequest,
  error?: string,
  status = 200,
  attemptsLeft?: number
): Response {
  const appPasswordUrl = findPreset(link.email)?.appPasswordUrl;
  const where = appPasswordUrl
    ? `Create one at <a href="${escapeHtml(appPasswordUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(new URL(appPasswordUrl).host)}</a>.`
    : 'Your mail provider issues it.';
  const problem = error
    ? `<p role="alert"><strong>${escapeHtml(error)}</strong>${
        attemptsLeft === undefined
          ? ''
          : ` ${attemptsLeft} ${attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`
      }</p>`
    : '';

  return htmlResponse(
    htmlPage(
      'Link a mailbox',
      `<h1>Link "${escapeHtml(link.alias)}"</h1>
       <p>${escapeHtml(link.email)} · IMAP ${escapeHtml(link.imapHost)}:${link.imapPort} · SMTP ${escapeHtml(link.smtpHost)}:${link.smtpPort}</p>
       ${problem}
       <form method="post">
         <fieldset>
           <legend>App password<small>Never your normal password. ${where}</small></legend>
           <input type="password" name="app_password" autocomplete="off" required autofocus>
         </fieldset>
         <button type="submit">Link mailbox</button>
       </form>`
    ),
    status
  );
}

function gone(): Response {
  return htmlResponse(
    message(
      'This link no longer works',
      'It expired, was already used or ran out of attempts. Ask Claude for a new one.'
    ),
    404
  );
}

function message(title: string, detail: string): string {
  return htmlPage(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
  );
}
