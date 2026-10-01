export function databaseNameFromUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || name.includes('/')) throw new Error('DATABASE_URL must name one database');
  return name;
}

export function assertDatabaseTarget(
  databaseUrl: string,
  expectedName?: string,
  production = false,
): void {
  if (production && !expectedName)
    throw new Error('EXPECTED_DATABASE_NAME is required in production');
  const actualName = databaseNameFromUrl(databaseUrl);
  if (expectedName && actualName !== expectedName) {
    throw new Error(`DATABASE_URL targets ${actualName}, expected ${expectedName}`);
  }
}

export function assertLocalTestDatabase(testUrl?: string): string {
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required');
  const url = new URL(testUrl);
  const name = databaseNameFromUrl(testUrl);
  if (!name.endsWith('_test') || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('TEST_DATABASE_URL must target a local _test database');
  }
  return testUrl;
}
