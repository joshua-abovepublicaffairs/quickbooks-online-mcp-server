/**
 * QUICKBOOKS_ERROR_LOG_PATH must be absolute, validated at module import —
 * mirrors QUICKBOOKS_TOKEN_STORE_PATH's own validation in quickbooks-client.ts.
 */
process.env.QUICKBOOKS_ERROR_LOG_PATH = 'relative/path/error.log';

describe('QUICKBOOKS_ERROR_LOG_PATH validation', () => {
  it('throws at import when the override is not an absolute path', async () => {
    await expect(import('../../../src/helpers/error-log')).rejects.toThrow(
      'QUICKBOOKS_ERROR_LOG_PATH must be an absolute path'
    );
  });
});
