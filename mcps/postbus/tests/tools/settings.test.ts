import { describe, expect, it, vi } from 'vitest';
import {
  assertMailTargetAllowed,
  resolveSettings
} from '../../src/tools/accounts.js';
import {
  detectPreset,
  findPreset,
  findPresetByHost,
  type MxResolver
} from '../../src/providers/imap/presets.js';
import { PostbusError } from '../../src/types.js';

const noMx: MxResolver = () => Promise.resolve([]);

function mx(...exchanges: string[]): MxResolver {
  return () =>
    Promise.resolve(
      exchanges.map((exchange, index) => ({ exchange, priority: index * 10 }))
    );
}

describe('findPreset', () => {
  it('recognises well-known domains', () => {
    expect(findPreset('souf@gmail.com')?.imapHost).toBe('imap.gmail.com');
    expect(findPreset('souf@hotmail.nl')?.imapHost).toBe(
      'outlook.office365.com'
    );
    expect(findPreset('souf@me.com')?.imapHost).toBe('imap.mail.me.com');
  });

  it('matches by name and ignores case', () => {
    expect(findPreset('Fastmail')?.smtpHost).toBe('smtp.fastmail.com');
    expect(findPreset('GMAIL')?.imapHost).toBe('imap.gmail.com');
  });

  it('returns nothing for an unknown domain', () => {
    expect(findPreset('souf@ownserver.com')).toBeUndefined();
    expect(findPreset(undefined)).toBeUndefined();
  });
});

describe('detectPreset', () => {
  it('skips DNS for a well-known domain', async () => {
    const resolver = vi.fn(noMx);

    expect((await detectPreset('souf@gmail.com', resolver))?.imapHost).toBe(
      'imap.gmail.com'
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('recognises Google Workspace and Microsoft 365 on a custom domain', async () => {
    expect(
      (await detectPreset('souf@studiosouf.com', mx('smtp.google.com.')))
        ?.imapHost
    ).toBe('imap.gmail.com');
    expect(
      (
        await detectPreset(
          'souf@example.nl',
          mx('example-nl.mail.protection.outlook.com')
        )
      )?.smtpPort
    ).toBe(587);
  });

  it('follows the preferred MX record', async () => {
    const resolver: MxResolver = () =>
      Promise.resolve([
        { exchange: 'in1-smtp.messagingengine.com', priority: 20 },
        { exchange: 'mx.zoho.eu', priority: 10 }
      ]);

    expect((await detectPreset('a@example.com', resolver))?.imapHost).toBe(
      'imap.zoho.eu'
    );
  });

  it('does not match a host that only ends in a known name', async () => {
    expect(
      await detectPreset('a@example.com', mx('mail.notgoogle.com'))
    ).toBeUndefined();
  });

  it('gives up quietly on a failing or slow resolver', async () => {
    expect(
      await detectPreset('a@example.com', () =>
        Promise.reject(new Error('ENOTFOUND'))
      )
    ).toBeUndefined();

    vi.useFakeTimers();
    try {
      const pending = detectPreset(
        'a@example.com',
        () => new Promise(() => {})
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('findPresetByHost', () => {
  it('finds a provider by its IMAP host', () => {
    expect(findPresetByHost('IMAP.gmail.com')?.appPasswordUrl).toBe(
      'https://myaccount.google.com/apppasswords'
    );
    expect(findPresetByHost('imap.ownserver.com')).toBeUndefined();
  });
});

describe('resolveSettings', () => {
  it('fills in a custom domain from its MX records', async () => {
    const settings = await resolveSettings(
      { email: 'souf@studiosouf.com' },
      mx('aspmx.l.google.com', 'alt1.aspmx.l.google.com')
    );

    expect(settings.imapHost).toBe('imap.gmail.com');
    expect(settings.smtpHost).toBe('smtp.gmail.com');
  });

  it('uses the US servers for a zoho.com address', async () => {
    expect((await resolveSettings({ email: 'a@zoho.com' })).imapHost).toBe(
      'imap.zoho.com'
    );
  });

  it('fills in host and port for a known provider', async () => {
    expect(await resolveSettings({ email: 'souf@gmail.com' })).toEqual({
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpSecure: true
    });
  });

  it('picks STARTTLS where the provider wants it (Outlook on 587)', async () => {
    const settings = await resolveSettings({ email: 'souf@outlook.com' });

    expect(settings.smtpPort).toBe(587);
    expect(settings.smtpSecure).toBe(false);
  });

  it('does not force implicit TLS on a non-standard port', async () => {
    // Regression: port 3143 used to get implicit TLS and the connection blew up.
    const settings = await resolveSettings({
      email: 'souf@ownserver.com',
      imap_host: '127.0.0.1',
      imap_port: 3143,
      smtp_host: '127.0.0.1',
      smtp_port: 3025
    });

    expect(settings.imapSecure).toBe(false);
    expect(settings.smtpSecure).toBe(false);
  });

  it('keeps implicit TLS on the standard ports', async () => {
    const settings = await resolveSettings({
      email: 'souf@ownserver.com',
      imap_host: 'imap.ownserver.com',
      imap_port: 993,
      smtp_host: 'smtp.ownserver.com',
      smtp_port: 465
    });

    expect(settings.imapSecure).toBe(true);
    expect(settings.smtpSecure).toBe(true);
  });

  it('lets the user override TLS explicitly', async () => {
    const settings = await resolveSettings({
      email: 'souf@ownserver.com',
      imap_host: 'imap.ownserver.com',
      imap_port: 1993,
      imap_secure: true,
      smtp_host: 'smtp.ownserver.com',
      smtp_port: 465,
      smtp_secure: false
    });

    expect(settings.imapSecure).toBe(true);
    expect(settings.smtpSecure).toBe(false);
  });

  it('lets an explicit host win over the preset', async () => {
    const settings = await resolveSettings({
      email: 'souf@gmail.com',
      imap_host: 'imap.own-proxy.com'
    });

    expect(settings.imapHost).toBe('imap.own-proxy.com');
    expect(settings.smtpHost).toBe('smtp.gmail.com');
  });

  it('asks for server details when the domain is unknown', async () => {
    try {
      await resolveSettings({ email: 'souf@ownserver.com' }, noMx);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PostbusError);
      expect((error as PostbusError).message).toContain('souf@ownserver.com');
      expect((error as PostbusError).hint).toMatch(/imap_host/);
    }
  });
});

describe('assertMailTargetAllowed', () => {
  const PUBLIC = {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465
  };

  it('allows a normal public mailbox', async () => {
    await expect(assertMailTargetAllowed(PUBLIC)).resolves.toBeUndefined();
  });

  it('refuses a host inside the private network', async () => {
    await expect(
      assertMailTargetAllowed({ ...PUBLIC, imapHost: '10.0.0.5' })
    ).rejects.toThrow(/private network/);
  });

  it('refuses a public host on a port that is not a mail port', async () => {
    await expect(
      assertMailTargetAllowed({ ...PUBLIC, imapPort: 8080 })
    ).rejects.toThrow(/not a IMAP port/);
    await expect(
      assertMailTargetAllowed({ ...PUBLIC, smtpPort: 22 })
    ).rejects.toThrow(/not a SMTP port/);
  });

  // Proton Mail Bridge is a shipped preset on 127.0.0.1:1143 and :1025.
  it('lets a local bridge choose its own ports', async () => {
    await expect(
      assertMailTargetAllowed({
        imapHost: '127.0.0.1',
        imapPort: 1143,
        smtpHost: '127.0.0.1',
        smtpPort: 1025
      })
    ).resolves.toBeUndefined();
  });
});
