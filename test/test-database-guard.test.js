// Test-database isolation guard (2026-10 authentication hardening, Phase 0). Pure checks — the URIs below
// are fabricated examples and nothing here opens a connection to any of them.
const { isSafeTestDatabaseUri, resolveTestDatabaseUri, DEFAULT_TEST_MONGO_URI } = require('../services/testDatabaseGuard');

describe('isSafeTestDatabaseUri accepts only a local database explicitly named as a test database', () => {
  test.each([
    'mongodb://127.0.0.1:27018/ciprms_test',
    'mongodb://localhost:27018/ciprms_test',
    'mongodb://localhost/ciprms_test',
    'mongodb://[::1]:27018/ciprms_test',
    'mongodb://127.0.0.1:27018/ciprms_test?directConnection=true',
    'mongodb://user:pass@127.0.0.1:27018/other_test'
  ])('accepts %s', (uri) => {
    expect(isSafeTestDatabaseUri(uri)).toBe(true);
  });

  test.each([
    ['a hosted SRV cluster, even with a _test name', 'mongodb+srv://user:pass@cluster0.example.mongodb.net/ciprms_test'],
    ['a remote host', 'mongodb://db.example.com:27017/ciprms_test'],
    ['a docker-compose service hostname', 'mongodb://mongo:27017/ciprms_test'],
    ['a replica set that includes one remote member', 'mongodb://127.0.0.1:27018,db.example.com:27017/ciprms_test'],
    ['the real database name on localhost', 'mongodb://127.0.0.1:27017/ciprms'],
    ['a name that merely contains "test"', 'mongodb://127.0.0.1:27018/test_ciprms'],
    ['no database name at all', 'mongodb://127.0.0.1:27018/'],
    ['no path at all', 'mongodb://127.0.0.1:27018'],
    ['an empty string', ''],
    ['a non-string', undefined],
    ['a look-alike host with a loopback prefix', 'mongodb://127.0.0.1.evil.example:27017/ciprms_test']
  ])('rejects %s', (_label, uri) => {
    expect(isSafeTestDatabaseUri(uri)).toBe(false);
  });
});

describe('resolveTestDatabaseUri', () => {
  test('defaults to the local Docker test database when TEST_MONGO_URI is unset', () => {
    expect(resolveTestDatabaseUri({})).toBe(DEFAULT_TEST_MONGO_URI);
    expect(isSafeTestDatabaseUri(DEFAULT_TEST_MONGO_URI)).toBe(true);
  });

  test('throws for an unsafe TEST_MONGO_URI, without echoing the URI (it may contain credentials)', () => {
    const secretish = 'mongodb+srv://someone:hunter2@cluster0.example.mongodb.net/ciprms';
    expect(() => resolveTestDatabaseUri({ TEST_MONGO_URI: secretish })).toThrow(/Refusing to run tests/);
    try { resolveTestDatabaseUri({ TEST_MONGO_URI: secretish }); } catch (err) {
      expect(err.message).not.toContain('hunter2');
      expect(err.message).not.toContain('cluster0');
    }
  });
});

describe('this very test process is isolated', () => {
  test('MONGO_URI seen by the app is a safe test database (set by test/setup-env.js before db.js loaded)', () => {
    expect(isSafeTestDatabaseUri(process.env.MONGO_URI)).toBe(true);
  });

  test('db.js refuses to load in a test process when MONGO_URI is not a test database', () => {
    const saved = process.env.MONGO_URI;
    jest.isolateModules(() => {
      process.env.MONGO_URI = 'mongodb+srv://someone:hunter2@cluster0.example.mongodb.net/ciprms';
      try {
        expect(() => require('../db')).toThrow(/Refusing to connect/);
      } finally {
        process.env.MONGO_URI = saved;
      }
    });
  });
});
