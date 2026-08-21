/**
 * Behavioral tests for the local troubleshooting error log.
 *
 * `buildLogEntry` is pure and tested directly with a fixture table covering
 * every shape of caught error (plain, string, axios-shaped QuickBooks API
 * failures with partial/complete config+response, and node-quickbooks Fault
 * bodies). `logError`'s file I/O is tested separately with `fs`/`os` mocked,
 * using the module's default path resolution (neither QUICKBOOKS_ERROR_LOG_PATH
 * nor QUICKBOOKS_TOKEN_STORE_PATH set) — the token-store-relative and explicit
 * -override defaults are covered in their own files since the path is resolved
 * once at module import.
 *
 * `logError` memoizes its mkdir/size-probe/chmod work per module instance, so
 * the tests that exercise those first-call paths re-import a fresh module
 * rather than sharing state.
 */
import { jest } from '@jest/globals';

delete process.env.QUICKBOOKS_ERROR_LOG_PATH;
delete process.env.QUICKBOOKS_TOKEN_STORE_PATH;

const appendFileSyncSpy = jest.fn<(p: string, data: string, options?: any) => void>();
const mkdirSyncSpy = jest.fn<(p: string, options?: any) => void>();
const chmodSyncSpy = jest.fn<(p: string, mode: number) => void>();
const statSyncSpy = jest.fn<(p: string) => { size: number }>();
const renameSyncSpy = jest.fn<(from: string, to: string) => void>();

jest.unstable_mockModule('fs', () => ({
  default: {
    mkdirSync: mkdirSyncSpy,
    appendFileSync: appendFileSyncSpy,
    chmodSync: chmodSyncSpy,
    statSync: statSyncSpy,
    renameSync: renameSyncSpy,
  },
}));

jest.unstable_mockModule('os', () => ({
  default: { homedir: () => '/home/testuser' },
}));

const { logError, buildLogEntry, ERROR_LOG_PATH } = await import('../../../src/helpers/error-log');

/** A fresh module instance, so the per-process memoization starts clean. */
const freshLogError = async () => {
  jest.resetModules();
  const mod = await import('../../../src/helpers/error-log');
  return mod.logError;
};

const MAX_LOG_BYTES = 5 * 1024 * 1024;

describe('ERROR_LOG_PATH default (no env overrides)', () => {
  it('falls back to ~/.config/quickbooks-mcp/error.log', () => {
    expect(ERROR_LOG_PATH).toBe('/home/testuser/.config/quickbooks-mcp/error.log');
  });
});

describe('buildLogEntry', () => {
  const cases: Array<[string, unknown, ReturnType<typeof buildLogEntry>]> = [
    ['Error instance', new Error('boom'), { message: 'boom' }],
    ['string error', 'raw string', { message: 'raw string' }],
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

describe('buildLogEntry — non-Error objects are never dumped wholesale', () => {
  // node-quickbooks hands the RAW QuickBooks response body to the callback on a
  // Fault, so these objects are the common non-Error input. Fault.Error[].Detail
  // echoes the submitted payload (customer names, amounts, addresses) and must
  // never reach the log; only the fixed-catalogue code/Message pair may.
  const cases: Array<[string, unknown, string]> = [
    ['plain object with no Fault', { code: 1 }, 'Non-Error object (contents withheld)'],
    ['Fault present but not an object', { Fault: 'weird' }, 'Non-Error object (contents withheld)'],
    ['Fault.Error missing', { Fault: {} }, 'Non-Error object (contents withheld)'],
    [
      'Fault.Error not an array',
      { Fault: { Error: 'weird' } },
      'Non-Error object (contents withheld)',
    ],
    [
      'Fault.Error with a non-object entry',
      { Fault: { Error: [null] } },
      'Non-Error object (contents withheld)',
    ],
    [
      'Fault entry carrying only Detail (the sensitive field)',
      { Fault: { Error: [{ Detail: 'Customer Jane Doe, jane@example.com, $4,210.00' }] } },
      'Non-Error object (contents withheld)',
    ],
    [
      'Fault entry with code only',
      { Fault: { Error: [{ code: '6140' }] } },
      'QuickBooks Fault (code 6140)',
    ],
    [
      'Fault entry with Message only',
      { Fault: { Error: [{ Message: 'Duplicate Document Number Error' }] } },
      'QuickBooks Fault (Duplicate Document Number Error)',
    ],
    [
      'Fault entry with code + Message, Detail withheld',
      {
        Fault: {
          Error: [
            {
              code: '6140',
              Message: 'Duplicate Document Number Error',
              Detail: 'Duplicate Document Number Error : You must specify a different number. DocNumber=1037',
            },
          ],
          type: 'ValidationFault',
        },
      },
      'QuickBooks Fault (code 6140: Duplicate Document Number Error)',
    ],
    [
      'multiple Fault entries joined',
      {
        Fault: {
          Error: [
            { code: '610', Message: 'Object Not Found' },
            { code: '2010', Message: 'Request has invalid params' },
          ],
        },
      },
      'QuickBooks Fault (code 610: Object Not Found; code 2010: Request has invalid params)',
    ],
  ];

  it.each(cases)('%s', (_name, error, expectedMessage) => {
    expect(buildLogEntry(error).message).toBe(expectedMessage);
  });

  it('never leaks a Detail string into the entry', () => {
    const secret = 'Customer Jane Doe, jane@example.com, $4,210.00';
    const entry = buildLogEntry({
      Fault: { Error: [{ code: '6140', Message: 'Duplicate Document Number Error', Detail: secret }] },
    });
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain('jane@example.com');
  });

  it('still captures operation/status/intuitTid alongside a withheld body', () => {
    const entry = buildLogEntry({
      Fault: { Error: [{ code: '610', Message: 'Object Not Found' }] },
      config: { method: 'get', url: 'https://quickbooks.api.intuit.com/v3/company/9/invoice/5' },
      response: { status: 404, headers: { intuit_tid: 'tid-9' } },
    });
    expect(entry).toEqual({
      message: 'QuickBooks Fault (code 610: Object Not Found)',
      operation: 'GET /v3/company/9/invoice/5',
      status: 404,
      intuitTid: 'tid-9',
    });
  });
});

describe('logError', () => {
  beforeEach(() => {
    appendFileSyncSpy.mockReset();
    mkdirSyncSpy.mockReset();
    chmodSyncSpy.mockReset();
    renameSyncSpy.mockReset();
    // Default: no log file on disk yet, so the size probe reports "absent".
    statSyncSpy.mockReset();
    statSyncSpy.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('appends a JSON line with a timestamp to the resolved log path, mode 0600', async () => {
    const log = await freshLogError();
    log(new Error('boom'));

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

  it('does the mkdir, size probe and chmod once, then only appends', async () => {
    const log = await freshLogError();

    log(new Error('first'));
    expect(mkdirSyncSpy).toHaveBeenCalledTimes(1);
    expect(statSyncSpy).toHaveBeenCalledTimes(1);
    expect(chmodSyncSpy).toHaveBeenCalledTimes(1);

    log(new Error('second'));
    log(new Error('third'));

    // One blocking syscall per error after the first, not four.
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(3);
    expect(mkdirSyncSpy).toHaveBeenCalledTimes(1);
    expect(statSyncSpy).toHaveBeenCalledTimes(1);
    expect(chmodSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('rotates to a single .1 backup once the cap is reached', async () => {
    statSyncSpy.mockReturnValue({ size: MAX_LOG_BYTES });
    const log = await freshLogError();

    log(new Error('overflows the cap'));

    expect(renameSyncSpy).toHaveBeenCalledWith(ERROR_LOG_PATH, `${ERROR_LOG_PATH}.1`);
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
    // The rotated-in file is new, so its mode is restated.
    expect(chmodSyncSpy).toHaveBeenCalledWith(ERROR_LOG_PATH, 0o600);
  });

  it('tracks size in memory and rotates again only when the fresh log refills', async () => {
    statSyncSpy.mockReturnValue({ size: MAX_LOG_BYTES - 10 });
    const log = await freshLogError();

    log(new Error('a'.repeat(200))); // pushes past the cap -> rotate
    expect(renameSyncSpy).toHaveBeenCalledTimes(1);

    log(new Error('small')); // fresh file has room -> no second rotation
    expect(renameSyncSpy).toHaveBeenCalledTimes(1);
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps appending when the rotation rename fails', async () => {
    statSyncSpy.mockReturnValue({ size: MAX_LOG_BYTES });
    renameSyncSpy.mockImplementation(() => {
      throw new Error('EXDEV');
    });
    const log = await freshLogError();

    expect(() => log(new Error('boom'))).not.toThrow();
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('never throws when mkdirSync fails, and skips the append', async () => {
    mkdirSyncSpy.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const log = await freshLogError();

    expect(() => log(new Error('boom'))).not.toThrow();
    expect(appendFileSyncSpy).not.toHaveBeenCalled();
  });

  it('never throws when appendFileSync fails', async () => {
    appendFileSyncSpy.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const log = await freshLogError();

    expect(() => log(new Error('boom'))).not.toThrow();
  });

  it('swallows a chmodSync failure without affecting the append', async () => {
    chmodSyncSpy.mockImplementation(() => {
      throw new Error('EPERM');
    });
    const log = await freshLogError();

    expect(() => log(new Error('boom'))).not.toThrow();
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
  });
});
