/**
 * Behavioral tests for the local troubleshooting error log.
 *
 * `buildLogEntry` is pure and tested directly with a fixture table covering
 * every shape of caught error (plain, string, axios-shaped QuickBooks API
 * failures with partial/complete config+response). `logError`'s file I/O is
 * tested separately with `fs`/`os` mocked, using the module's default path
 * resolution (neither QUICKBOOKS_ERROR_LOG_PATH nor QUICKBOOKS_TOKEN_STORE_PATH
 * set) — the token-store-relative and explicit-override defaults are covered
 * in their own files since the path is resolved once at module import.
 */
import { jest } from '@jest/globals';

delete process.env.QUICKBOOKS_ERROR_LOG_PATH;
delete process.env.QUICKBOOKS_TOKEN_STORE_PATH;

const appendFileSyncSpy = jest.fn<(p: string, data: string, options?: any) => void>();
const mkdirSyncSpy = jest.fn<(p: string, options?: any) => void>();
const chmodSyncSpy = jest.fn<(p: string, mode: number) => void>();

jest.unstable_mockModule('fs', () => ({
  default: {
    mkdirSync: mkdirSyncSpy,
    appendFileSync: appendFileSyncSpy,
    chmodSync: chmodSyncSpy,
  },
}));

jest.unstable_mockModule('os', () => ({
  default: { homedir: () => '/home/testuser' },
}));

const { logError, buildLogEntry, ERROR_LOG_PATH } = await import('../../../src/helpers/error-log');

describe('ERROR_LOG_PATH default (no env overrides)', () => {
  it('falls back to ~/.config/quickbooks-mcp/error.log', () => {
    expect(ERROR_LOG_PATH).toBe('/home/testuser/.config/quickbooks-mcp/error.log');
  });
});

describe('buildLogEntry', () => {
  const cases: Array<[string, unknown, ReturnType<typeof buildLogEntry>]> = [
    ['Error instance', new Error('boom'), { message: 'boom' }],
    ['string error', 'raw string', { message: 'raw string' }],
    ['plain object error', { code: 1 }, { message: '{"code":1}' }],
    ['null error', null, { message: 'null' }],
    ['primitive number error', 42, { message: '42' }],
    [
      'config present but not an object',
      Object.assign(new Error('x'), { config: 'weird' }),
      { message: 'x' },
    ],
    [
      'config missing method',
      Object.assign(new Error('x'), {
        config: { url: 'https://sandbox-quickbooks.api.intuit.com/v3/company/1/customer' },
      }),
      { message: 'x' },
    ],
    [
      'config missing url',
      Object.assign(new Error('x'), { config: { method: 'post' } }),
      { message: 'x' },
    ],
    [
      'config with method + valid absolute url (query string stripped)',
      Object.assign(new Error('x'), {
        config: {
          method: 'post',
          url: 'https://sandbox-quickbooks.api.intuit.com/v3/company/1/customer?minorversion=75',
        },
      }),
      { message: 'x', operation: 'POST /v3/company/1/customer' },
    ],
    [
      'config with method + non-parseable url (fallback split)',
      Object.assign(new Error('x'), { config: { method: 'get', url: 'not a url' } }),
      { message: 'x', operation: 'GET not a url' },
    ],
    [
      'response present but not an object',
      Object.assign(new Error('x'), { response: 'weird' }),
      { message: 'x' },
    ],
    [
      'response with non-numeric status',
      Object.assign(new Error('x'), { response: { status: '400' } }),
      { message: 'x' },
    ],
    [
      'response with numeric status, no headers',
      Object.assign(new Error('x'), { response: { status: 400 } }),
      { message: 'x', status: 400 },
    ],
    [
      'response headers present but not an object',
      Object.assign(new Error('x'), { response: { headers: 'weird' } }),
      { message: 'x' },
    ],
    [
      'response headers missing intuit_tid',
      Object.assign(new Error('x'), { response: { status: 400, headers: {} } }),
      { message: 'x', status: 400 },
    ],
    [
      'response headers intuit_tid not a string',
      Object.assign(new Error('x'), {
        response: { status: 400, headers: { intuit_tid: 12345 } },
      }),
      { message: 'x', status: 400 },
    ],
    [
      'full axios-shaped QuickBooks API error',
      Object.assign(new Error('Request failed with status code 400'), {
        config: {
          method: 'post',
          url: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123/customer?minorversion=75',
        },
        response: { status: 400, headers: { intuit_tid: 'abc-123-def' } },
      }),
      {
        message: 'Request failed with status code 400',
        operation: 'POST /v3/company/123/customer',
        status: 400,
        intuitTid: 'abc-123-def',
      },
    ],
  ];

  it.each(cases)('%s', (_name, error, expected) => {
    expect(buildLogEntry(error)).toEqual(expected);
  });
});

describe('logError', () => {
  beforeEach(() => {
    appendFileSyncSpy.mockClear();
    mkdirSyncSpy.mockClear();
    chmodSyncSpy.mockClear();
  });

  it('appends a JSON line with a timestamp to the resolved log path, mode 0600', () => {
    logError(new Error('boom'));

    expect(mkdirSyncSpy).toHaveBeenCalledWith('/home/testuser/.config/quickbooks-mcp', {
      recursive: true,
    });
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
    const [filePath, line, opts] = appendFileSyncSpy.mock.calls[0];
    expect(filePath).toBe(ERROR_LOG_PATH);
    expect(opts).toEqual({ mode: 0o600 });
    expect(String(line).endsWith('\n')).toBe(true);
    const parsed = JSON.parse(String(line).trim());
    expect(parsed).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      message: 'boom',
    });
    expect(chmodSyncSpy).toHaveBeenCalledWith(ERROR_LOG_PATH, 0o600);
  });

  it('never throws when mkdirSync fails, and skips the append', () => {
    mkdirSyncSpy.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    expect(() => logError(new Error('boom'))).not.toThrow();
    expect(appendFileSyncSpy).not.toHaveBeenCalled();
  });

  it('never throws when appendFileSync fails', () => {
    appendFileSyncSpy.mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });

    expect(() => logError(new Error('boom'))).not.toThrow();
  });

  it('swallows a chmodSync failure without affecting the append', () => {
    chmodSyncSpy.mockImplementationOnce(() => {
      throw new Error('EPERM');
    });

    expect(() => logError(new Error('boom'))).not.toThrow();
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
  });
});
