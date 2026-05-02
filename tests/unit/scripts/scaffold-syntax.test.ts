import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('scaffold bash syntax', () => {
  it.each([
    'scripts/create-account-repo.sh',
    'scripts/bootstrap.sh',
    'scripts/migrate-from-python.sh',
  ])('bash -n %s', async (script) => {
    await expect(execFileAsync('bash', ['-n', script])).resolves.toBeDefined();
  });
});
