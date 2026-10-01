import { describe, expect, it } from 'vitest';
import {
  assertDatabaseTarget,
  assertLocalTestDatabase,
  databaseNameFromUrl,
} from '../src/database-target.js';

describe('database target safeguards', () => {
  const stageUrl =
    'postgresql://app:secret@db.example.test:5432/kleenbay_stage?sslmode=verify-full';

  it('reads the database name without depending on host or TLS options', () => {
    expect(databaseNameFromUrl(stageUrl)).toBe('kleenbay_stage');
    expect(databaseNameFromUrl('postgres://app:secret@localhost:5432/carwash')).toBe('carwash');
  });

  it('requires an explicit target in production', () => {
    expect(() => assertDatabaseTarget(stageUrl, undefined, true)).toThrow('EXPECTED_DATABASE_NAME');
    expect(() => assertDatabaseTarget(stageUrl, 'kleenbay', true)).toThrow('expected kleenbay');
    expect(() => assertDatabaseTarget(stageUrl, 'kleenbay_stage', true)).not.toThrow();
  });

  it('rejects non-PostgreSQL and missing database names', () => {
    expect(() => databaseNameFromUrl('https://db.example.test/kleenbay')).toThrow('PostgreSQL');
    expect(() => databaseNameFromUrl('postgresql://db.example.test/')).toThrow('one database');
  });

  it('keeps destructive tests on a loopback _test database', () => {
    expect(
      assertLocalTestDatabase('postgresql://app:secret@localhost:5432/carwash_test'),
    ).toContain('carwash_test');
    expect(() =>
      assertLocalTestDatabase('postgresql://app:secret@db.example.test:5432/kleenbay_test'),
    ).toThrow('local _test');
    expect(() =>
      assertLocalTestDatabase('postgresql://app:secret@localhost:5432/kleenbay'),
    ).toThrow('local _test');
  });
});
