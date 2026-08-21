/**
 * Behavioral tests for saveTokensToEnv symlink handling.
 *
 * Exercises the real QuickbooksClient.saveTokensToEnv logic via the public
 * authenticate() → refreshAccessToken() path, using jest.unstable_mockModule
 * to control fs behavior. Mirrors the pattern from quickbooks-client.auth.test.ts.
 *
 * Covers:
 * 1. Regular file: atomic temp+rename path (existing behavior).
 * 2. Symlinked .env: writes through to realpathSync target, no rename.
 * 3. Dangling symlink: readlinkSync fallback when target doesn't exist.
 * 4. isSymbolicLink: fails closed (returns false) on any fs error.
 */
import { jest } from '@jest/globals';
import nodeCrypto from 'crypto';

process.env.QUICKBOOKS_CLIENT_ID = 'test-client-id';
process.env.QUICKBOOKS_CLIENT_SECRET = 'test-client-secret';
process.env.QUICKBOOKS_REFRESH_TOKEN = 'initial-token';
process.env.QUICKBOOKS_REALM_ID = '99999';
process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';
process.env.QUICKBOOKS_REDIRECT_URI = 'http://localhost:8000/callback';

// --- fs mock state (mutated by each test) ---
let lstatBehavior: 'regular' | 'symlink' | 'throws' = 'regular';
let realpathBehavior: 'ok' | 'enoent' | 'eacces' = 'ok';
const REAL_PATH = '/persistent-volume/.env';
const LINK_TARGET = '/fresh-pvc/.env';
// Configurable readlinkSync return so tests can exercise absolute vs relative targets.
let readlinkTarget: string = LINK_TARGET;

const writeFileSyncSpy = jest.fn<(p: string, data: string, options?: any) => void>();
const renameSyncSpy = jest.fn<(o: string, n: string) => void>();
const unlinkSyncSpy = jest.fn<(p: string) => void>();

// The refresh token is stored encrypted, so the fs mock has to model TWO files:
// the token store and the sibling AES key file. A fixed key keeps ciphertext
// decryptable by the assertions below.
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const isKeyPath = (p: unknown) => String(p).endsWith('.qbo-token-key');

// Contents the mocked token store reports. Mutable so tests can supply the
// alternative assignment forms dotenv accepts (export prefix, leading
// whitespace, `KEY: value`) and check they are rewritten, not just read.
const DEFAULT_STORE = 'QUICKBOOKS_REFRESH_TOKEN=old-token\nQUICKBOOKS_REALM_ID=99999\n';
let storeContent = DEFAULT_STORE;

jest.unstable_mockModule('fs', () => ({
  default: {
    existsSync: jest.fn(() => true),
    readFileSync: jest.fn((p: unknown) => (isKeyPath(p) ? TEST_KEY_B64 : storeContent)),
    writeFileSync: writeFileSyncSpy,
    renameSync: renameSyncSpy,
    unlinkSync: unlinkSyncSpy,
    mkdirSync: jest.fn(),
    chmodSync: jest.fn(),
    lstatSync: jest.fn(() => {
      if (lstatBehavior === 'throws') throw new Error('EACCES');
      return { isSymbolicLink: () => lstatBehavior === 'symlink' };
    }),
    realpathSync: jest.fn(() => {
      if (realpathBehavior === 'enoent') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (realpathBehavior === 'eacces') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return REAL_PATH;
    }),
    readlinkSync: jest.fn(() => readlinkTarget),
  },
}));

// Mirror of the client's decryption, so assertions verify the value actually
// round-trips rather than merely that SOME ciphertext was written.
function decryptWritten(content: string): string {
  const line = content.split('\n').find((l) => l.startsWith('QUICKBOOKS_REFRESH_TOKEN_ENC='));
  if (!line) throw new Error(`no encrypted token line in: ${content}`);
  const [iv, tag, ct] = line.slice('QUICKBOOKS_REFRESH_TOKEN_ENC='.length)
    .split(':')
    .map((p) => Buffer.from(p, 'base64'));
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(TEST_KEY_B64, 'base64'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

// Each test needs a unique refresh token so saveTokensToEnv is triggered
// (it only runs when newRefreshToken !== this.refreshToken).
let tokenCounter = 0;
const refreshDispatch = jest.fn<(token: string) => Promise<unknown>>();

jest.unstable_mockModule('intuit-oauth', () => {
  class MockOAuthClient {
    static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
    refreshUsingToken = jest.fn((token: string) => refreshDispatch(token));
    createToken = jest.fn();
    authorizeUri = jest.fn(() => 'https://mock');
    constructor(_cfg: Record<string, unknown>) {}
  }
  return { default: MockOAuthClient };
});

jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks { constructor(..._args: unknown[]) {} },
}));

jest.unstable_mockModule('open', () => ({ default: jest.fn(async () => undefined) }));

jest.unstable_mockModule('http', () => ({
  default: {
    createServer: jest.fn(() => ({
      listen: jest.fn(),
      close: jest.fn(),
      on: jest.fn(),
      address: jest.fn(() => ({ port: 8000 })),
    })),
  },
}));

const { quickbooksClient } = await import('../../../src/clients/quickbooks-client');

describe('saveTokensToEnv (via authenticate)', () => {
  beforeEach(() => {
    writeFileSyncSpy.mockClear();
    renameSyncSpy.mockClear();
    unlinkSyncSpy.mockClear();
    lstatBehavior = 'regular';
    realpathBehavior = 'ok';
    readlinkTarget = LINK_TARGET;
    storeContent = DEFAULT_STORE;
    tokenCounter++;
    refreshDispatch.mockResolvedValue({
      token: {
        access_token: `access-${tokenCounter}`,
        expires_in: 3600,
        refresh_token: `rotated-${tokenCounter}`,
      },
    });
    // Force token expiry so authenticate() triggers refreshAccessToken()
    // which calls saveTokensToEnv() when the refresh token rotates.
    (quickbooksClient as any).accessTokenExpiry = new Date(0);
    (quickbooksClient as any).authInFlight = undefined;
  });

  it('uses atomic temp+rename for regular files (not symlinks)', async () => {
    lstatBehavior = 'regular';

    await quickbooksClient.authenticate();

    expect(renameSyncSpy).toHaveBeenCalled();
    const [tmpPath, destPath] = renameSyncSpy.mock.calls[0];
    expect(tmpPath).toContain('.env.tmp.');
    expect(destPath).toContain('.env');
    expect(writeFileSyncSpy).toHaveBeenCalled();
  });

  it('writes through symlink target via realpathSync (no rename)', async () => {
    lstatBehavior = 'symlink';
    realpathBehavior = 'ok';

    await quickbooksClient.authenticate();

    expect(renameSyncSpy).not.toHaveBeenCalled();
    const [writtenPath, content, opts] = writeFileSyncSpy.mock.calls.at(-1)!;
    expect(writtenPath).toBe(REAL_PATH);
    expect(opts).toEqual(expect.objectContaining({ mode: 0o600 }));
    expect(decryptWritten(content)).toBe(`rotated-${tokenCounter}`);
    // The plaintext line from the pre-encryption store must be gone.
    expect(content).not.toMatch(/^QUICKBOOKS_REFRESH_TOKEN=/m);
  });

  it('handles dangling symlink with an ABSOLUTE target via readlinkSync fallback', async () => {
    lstatBehavior = 'symlink';
    realpathBehavior = 'enoent';
    readlinkTarget = LINK_TARGET; // absolute — used as-is

    await quickbooksClient.authenticate();

    expect(renameSyncSpy).not.toHaveBeenCalled();
    const [writtenPath, content, opts] = writeFileSyncSpy.mock.calls.at(-1)!;
    expect(writtenPath).toBe(LINK_TARGET);
    expect(opts).toEqual(expect.objectContaining({ mode: 0o600 }));
    expect(decryptWritten(content)).toBe(`rotated-${tokenCounter}`);
  });

  it('resolves a RELATIVE dangling-symlink target against the link directory', async () => {
    lstatBehavior = 'symlink';
    realpathBehavior = 'enoent';
    // readlinkSync returns a relative target (as stored). It must be resolved
    // against the symlink's own directory, NOT the process cwd.
    readlinkTarget = '../data/.env';

    await quickbooksClient.authenticate();

    expect(renameSyncSpy).not.toHaveBeenCalled();
    // tokenPath is <install>/.env; dirname is <install>; ../data/.env resolves to
    // <install>/../data/.env. Assert the written path ends with the resolved suffix
    // and is absolute (not the bare relative string, and not cwd-relative).
    const writtenPath = writeFileSyncSpy.mock.calls[writeFileSyncSpy.mock.calls.length - 1][0] as string;
    expect(writtenPath).not.toBe('../data/.env'); // not written verbatim
    expect(writtenPath.startsWith('/')).toBe(true); // absolute
    expect(writtenPath.endsWith('/data/.env')).toBe(true); // resolved to link dir's sibling
  });

  it('falls back to atomic rename when lstatSync throws (isSymbolicLink fails closed)', async () => {
    lstatBehavior = 'throws';

    await quickbooksClient.authenticate();

    // isSymbolicLink returns false on error → uses the rename path
    expect(renameSyncSpy).toHaveBeenCalled();
  });

  it('swallows saveTokensToEnv errors without failing authenticate (non-ENOENT realpathSync)', async () => {
    lstatBehavior = 'symlink';
    realpathBehavior = 'eacces';

    // authenticate() catches saveTokensToEnv errors (line 336-338 in source)
    // and logs them; it should NOT throw.
    await expect(quickbooksClient.authenticate()).resolves.not.toThrow();
  });

  // The plaintext line is removed with a matcher that has to agree with
  // dotenv.parse(): dotenv reads the token, this deletes it. When the two
  // disagreed, a store written in any of these forms kept its plaintext refresh
  // token on disk forever while the migration reported success — defeating the
  // at-rest encryption entirely, with no functional symptom because
  // resolveRefreshToken() prefers the ciphertext.
  describe.each([
    ['export prefix', 'export QUICKBOOKS_REFRESH_TOKEN=old-token'],
    ['leading whitespace', '  QUICKBOOKS_REFRESH_TOKEN=old-token'],
    ['colon separator', 'QUICKBOOKS_REFRESH_TOKEN: old-token'],
    ['spaced equals', 'QUICKBOOKS_REFRESH_TOKEN = old-token'],
    ['export plus spacing', 'export  QUICKBOOKS_REFRESH_TOKEN  =  old-token'],
  ])('plaintext removal — %s', (_label, plaintextLine) => {
    it('drops the plaintext line and writes the encrypted one', async () => {
      storeContent = `${plaintextLine}\nQUICKBOOKS_REALM_ID=99999\n`;

      await quickbooksClient.authenticate();

      const content = writeFileSyncSpy.mock.calls.at(-1)![1] as string;

      // The secret itself is gone from the file, in any form.
      expect(content).not.toContain('old-token');
      expect(content.split('\n')).not.toContain(plaintextLine);
      // And the replacement really is the live token, encrypted.
      expect(decryptWritten(content)).toBe(`rotated-${tokenCounter}`);
    });
  });

  it('keeps the _ENC line when removing the plaintext one (no prefix over-match)', async () => {
    // QUICKBOOKS_REFRESH_TOKEN is a strict prefix of QUICKBOOKS_REFRESH_TOKEN_ENC,
    // so a looser matcher would strip the ciphertext it just wrote.
    storeContent =
      'QUICKBOOKS_REFRESH_TOKEN_ENC=stale:blob:here\nQUICKBOOKS_REALM_ID=99999\n';

    await quickbooksClient.authenticate();

    const content = writeFileSyncSpy.mock.calls.at(-1)![1] as string;
    const encLines = content.split('\n').filter((l) => l.startsWith('QUICKBOOKS_REFRESH_TOKEN_ENC='));
    expect(encLines).toHaveLength(1); // replaced in place, not duplicated or dropped
    expect(decryptWritten(content)).toBe(`rotated-${tokenCounter}`);
  });

  it('updates an export-prefixed realm id in place instead of appending a duplicate', async () => {
    // Same matcher powers the update path, where the old prefix check appended a
    // second assignment rather than replacing the existing one.
    storeContent = 'QUICKBOOKS_REFRESH_TOKEN=old-token\nexport QUICKBOOKS_REALM_ID=99999\n';

    await quickbooksClient.authenticate();

    const content = writeFileSyncSpy.mock.calls.at(-1)![1] as string;
    const realmLines = content.split('\n').filter((l) => /QUICKBOOKS_REALM_ID\s*(?:=|:\s)/.test(l));
    expect(realmLines).toHaveLength(1);
  });
});
