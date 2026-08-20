/**
 * Behavioral test for the error log's default path when only
 * QUICKBOOKS_TOKEN_STORE_PATH is set (no explicit QUICKBOOKS_ERROR_LOG_PATH).
 *
 * The path is resolved once at module import, so this file sets the env var
 * BEFORE importing, mirroring the pattern in
 * tests/unit/clients/token-store-path.test.ts. The no-override default is
 * covered by error-log.test.ts; the explicit-override precedence and the
 * invalid-path rejection are covered by their own sibling files for the same
 * reason.
 */
export {};

delete process.env.QUICKBOOKS_ERROR_LOG_PATH;
process.env.QUICKBOOKS_TOKEN_STORE_PATH = '/writable-volume/qbo-tokens.env';

const { ERROR_LOG_PATH } = await import('../../../src/helpers/error-log');

describe('ERROR_LOG_PATH default when only QUICKBOOKS_TOKEN_STORE_PATH is set', () => {
  it('resolves beside the configured token store, not the homedir fallback', () => {
    expect(ERROR_LOG_PATH).toBe('/writable-volume/error.log');
  });
});
