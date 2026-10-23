// Read existing dotenv values without evaluating shell code or printing passwords.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

try {
  const [filename, action] = process.argv.slice(2);
  const values = parseEnv(readFileSync(filename, 'utf8'));
  if (action === 'validate') {
    if (!values.BASIC_AUTH_PASSWORD || !values.BASIC_AUTH_PASSWORD.trim()) {
      throw new Error('The existing app.env/.env needs a nonempty BASIC_AUTH_PASSWORD.');
    }
    if (values.BASIC_AUTH_USER?.includes(':')) throw new Error('The Basic authentication username cannot contain a colon.');
  } else if (action === 'data-dir') {
    process.stdout.write(values.DATA_DIR || '');
  } else throw new Error('Unknown environment-file action.');
} catch (error) {
  console.error(`Deployment configuration error: ${error.message}`);
  process.exitCode = 1;
}
