import { jest } from '@jest/globals';

const logErrorSpy = jest.fn();

jest.unstable_mockModule('../../../src/helpers/error-log', () => ({
  logError: logErrorSpy,
}));

const { formatError } = await import('../../../src/helpers/format-error');

describe('formatError', () => {
  beforeEach(() => {
    logErrorSpy.mockClear();
  });

  it('logs every caught error to the troubleshooting log by default', () => {
    const error = new Error('Something went wrong');
    formatError(error);
    expect(logErrorSpy).toHaveBeenCalledWith(error);
  });

  it('skips the log when the caller opts out, still returning the message', () => {
    // The disk write is a side effect on a formatting helper, so a caller that
    // has already logged this error (or wants the string without the I/O) can
    // turn it off explicitly.
    const error = new Error('already logged upstream');
    expect(formatError(error, { log: false })).toBe('Error: already logged upstream');
    expect(logErrorSpy).not.toHaveBeenCalled();
  });

  it('logs when passed options that do not disable logging', () => {
    const error = new Error('boom');
    formatError(error, {});
    expect(logErrorSpy).toHaveBeenCalledWith(error);
  });

  it('should format Error instances', () => {
    const error = new Error('Something went wrong');
    expect(formatError(error)).toBe('Error: Something went wrong');
  });

  it('should format string errors', () => {
    expect(formatError('A string error')).toBe('Error: A string error');
  });

  it('should format unknown error types', () => {
    const unknownError = { code: 500, message: 'Server error' };
    expect(formatError(unknownError)).toBe(
      'Unknown error: {"code":500,"message":"Server error"}'
    );
  });

  it('should handle null errors', () => {
    expect(formatError(null)).toBe('Unknown error: null');
  });

  it('should handle undefined errors', () => {
    expect(formatError(undefined)).toBe('Unknown error: undefined');
  });

  it('should handle number errors', () => {
    expect(formatError(404)).toBe('Unknown error: 404');
  });
});
