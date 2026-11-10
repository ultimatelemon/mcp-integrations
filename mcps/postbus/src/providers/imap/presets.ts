import { resolveMx } from 'node:dns/promises';

export interface MailPreset {
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  appPasswordUrl?: string;
}

const GMAIL: MailPreset = {
  label: 'Gmail / Google Workspace',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
  appPasswordUrl: 'https://myaccount.google.com/apppasswords'
};

const OUTLOOK: MailPreset = {
  label: 'Outlook.com / Microsoft 365',
  imapHost: 'outlook.office365.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.office365.com',
  smtpPort: 587,
  smtpSecure: false,
  appPasswordUrl: 'https://account.microsoft.com/security'
};

export const PRESETS: Record<string, MailPreset> = {
  gmail: GMAIL,
  google: GMAIL,
  googlemail: GMAIL,
  outlook: OUTLOOK,
  hotmail: OUTLOOK,
  live: OUTLOOK,
  office365: OUTLOOK,
  fastmail: {
    label: 'Fastmail',
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apps'
  },
  icloud: {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpSecure: false,
    appPasswordUrl: 'https://account.apple.com/account/manage'
  },
  yahoo: {
    label: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: 'https://login.yahoo.com/account/security'
  },
  zoho: {
    label: 'Zoho Mail (EU)',
    imapHost: 'imap.zoho.eu',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.zoho.eu',
    smtpPort: 465,
    smtpSecure: true
  },
  'zoho-us': {
    label: 'Zoho Mail (US)',
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    smtpSecure: true
  },
  proton: {
    label: 'Proton Mail (via Proton Mail Bridge, local)',
    imapHost: '127.0.0.1',
    imapPort: 1143,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    smtpSecure: false
  }
};

const DOMAIN_MAP: Record<string, keyof typeof PRESETS> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'hotmail.nl': 'outlook',
  'live.nl': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'fastmail.com': 'fastmail',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'yahoo.com': 'yahoo',
  'zoho.com': 'zoho-us',
  'zoho.eu': 'zoho',
  'proton.me': 'proton',
  'protonmail.com': 'proton'
};

export function findPreset(
  nameOrEmail: string | undefined
): MailPreset | undefined {
  if (!nameOrEmail) return undefined;

  const value = nameOrEmail.trim().toLowerCase();
  const direct = PRESETS[value];
  if (direct) return direct;

  const domain = value.includes('@') ? value.split('@')[1] : value;
  if (!domain) return undefined;

  const mapped = DOMAIN_MAP[domain];
  if (mapped) return PRESETS[mapped];

  return undefined;
}

// A custom domain says nothing about its provider; its MX records do.
const MX_MAP: Array<[suffix: string, preset: keyof typeof PRESETS]> = [
  ['.google.com', 'gmail'],
  ['.googlemail.com', 'gmail'],
  ['.mail.protection.outlook.com', 'outlook'],
  ['.messagingengine.com', 'fastmail'],
  ['.mail.icloud.com', 'icloud'],
  ['.yahoodns.net', 'yahoo'],
  ['.zoho.eu', 'zoho'],
  ['.zoho.com', 'zoho-us'],
  ['.protonmail.ch', 'proton']
];

const MX_LOOKUP_TIMEOUT_MS = 3_000;

export type MxResolver = (
  domain: string
) => Promise<Array<{ exchange: string; priority: number }>>;

export async function detectPreset(
  email: string,
  resolver: MxResolver = resolveMx
): Promise<MailPreset | undefined> {
  const known = findPreset(email);
  if (known) return known;

  const domain = email.trim().toLowerCase().split('@')[1];
  if (!domain) return undefined;

  const records = await withTimeout(resolver(domain), MX_LOOKUP_TIMEOUT_MS);
  const exchanges = [...records]
    .sort((a, b) => a.priority - b.priority)
    .map((record) => `.${record.exchange.toLowerCase().replace(/\.$/, '')}`);

  for (const exchange of exchanges) {
    const match = MX_MAP.find(([suffix]) => exchange.endsWith(suffix));
    if (match) return PRESETS[match[1]];
  }
  return undefined;
}

// No answer, NXDOMAIN or a slow resolver all mean "unknown provider": the
// caller then asks for the servers instead.
function withTimeout<T>(promise: Promise<T[]>, ms: number): Promise<T[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ms).unref();
  });
  return Promise.race([promise.catch(() => []), timeout]).finally(() =>
    clearTimeout(timer)
  );
}

export function findPresetByHost(imapHost: string): MailPreset | undefined {
  const host = imapHost.trim().toLowerCase();
  return Object.values(PRESETS).find((preset) => preset.imapHost === host);
}

export function presetNames(): string[] {
  return [...new Set(Object.values(PRESETS).map((preset) => preset.label))];
}
