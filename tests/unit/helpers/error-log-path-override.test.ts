/**
 * Behavioral test for the explicit QUICKBOOKS_ERROR_LOG_PATH override, which
 * must win over the QUICKBOOKS_TOKEN_STORE_PATH-relative default. Resolved
 * once at module import — see error-log.test.ts for the no-override default
 * and error-log-token-store-path.test.ts for the token-store-relative default.
 */
export {};

process.env.QUICKBOOKS_ERROR_LOG_PATH = '/custom/log/dir/qbo-errors.log';
process.env.QUICKBOOKS_TOKEN_STORE_PATH = '/writable-volume/qbo-tokens.env';

const { ERROR_LOG_PATH } = await import('../../../src/helpers/error-log');

describe('QUICKBOOKS_ERROR_LOG_PATH override', () => {
  it('takes precedence over the token-store-relative default', () => {
    expect(ERROR_LOG_PATH).toBe('/custom/log/dir/qbo-errors.log');
  });
});
