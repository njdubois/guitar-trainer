import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, access, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';

const project = path.resolve(import.meta.dirname, '..');
const deployScript = path.join(project, 'deploy.sh');
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const installWithoutRoot = `
install() {
  local -a deploy_test_args=()
  while (($#)); do
    case "$1" in -o|-g) shift 2 ;; *) deploy_test_args+=("$1"); shift ;; esac
  done
  command install "\${deploy_test_args[@]}"
}
chown() { :; }
# The installer runs on Ubuntu; resolve GNU realpath -m inputs on the Mac QA host.
realpath() { "$DEPLOY_NODE" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$2"; }
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guitar-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['config', 'app/releases', 'systemd', 'apache/sites-available', 'apache/sites-enabled', 'source/deploy', 'work']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await copyFile(path.join(project, 'deploy/read-env.mjs'), path.join(root, 'source/deploy/read-env.mjs'));
  await copyFile(path.join(project, 'deploy/apache.conf'), path.join(root, 'source/deploy/apache.conf'));
  const prelude = `set -Eeuo pipefail
source ${shellQuote(deployScript)}
DEPLOY_SOURCE_DIR=${shellQuote(path.join(root, 'source'))}
DEPLOY_CONFIG_DIR=${shellQuote(path.join(root, 'config'))}
DEPLOY_APP_ROOT=${shellQuote(path.join(root, 'app'))}
DEPLOY_APACHE_ROOT=${shellQuote(path.join(root, 'apache'))}
DEPLOY_SYSTEMD_DIR=${shellQuote(path.join(root, 'systemd'))}
DEPLOY_DEFAULT_DATA=${shellQuote(path.join(root, 'stored-images'))}
DEPLOY_CACHE_DIR=${shellQuote(path.join(root, 'cache'))}
DEPLOY_TEMP=${shellQuote(path.join(root, 'work'))}
DEPLOY_NODE=${shellQuote(process.execPath)}
DEPLOY_DOMAIN=annotations.example.com
DEPLOY_EMAIL=owner@example.com
${installWithoutRoot}
`;
  const run = (code) => spawnSync('bash', ['-c', prelude + code], { encoding: 'utf8', timeout: 15000 });
  return { root, run, file: (...parts) => path.join(root, ...parts) };
}
const good = (result) => assert.equal(result.status, 0, result.stdout + result.stderr);
const exists = (filename) => access(filename).then(() => true, () => false);

test('deployment help runs without root, packages, or server changes', () => {
  const result = spawnSync('bash', [deployScript, '--help'], { encoding: 'utf8' });
  good(result); assert.match(result.stdout, /Apache/); assert.match(result.stdout, /--domain/);
});
test('domain and email validation reject URLs, wildcards, path injection, and malformed labels', async (t) => {
  const { run } = await fixture(t);
  for (const domain of ['annotations.example.com', 'guitar-01.example.co.uk', 'xn--guitar.example.com']) good(run(`deploy_validate_domain ${shellQuote(domain)}`));
  for (const domain of ['https://example.com', 'example.com/path', 'example.com:443', '*.example.com', 'bad..example.com', 'example.com.', '-bad.example.com', 'x.example-.com', '127.0.0.1', 'example.com; touch /tmp/a']) {
    assert.notEqual(run(`deploy_validate_domain ${shellQuote(domain)}`).status, 0, domain);
  }
  good(run('deploy_validate_email owner+guitar@example.com'));
  assert.notEqual(run('deploy_validate_email "owner@example.com --bad"').status, 0);
});
test('first setup generates credentials and a rerun preserves password and annotation data', async (t) => {
  const { root, run, file } = await fixture(t);
  good(run('deploy_prepare_environment'));
  const before = await readFile(file('config/app.env'), 'utf8');
  assert.match(parseEnv(before).BASIC_AUTH_PASSWORD, /^[0-9a-f]{40}$/);
  await writeFile(file('stored-images/records/keep.json'), '{"keep":true}');
  good(run('deploy_prepare_environment'));
  assert.equal(await readFile(file('config/app.env'), 'utf8'), before);
  assert.equal(await readFile(file('stored-images/records/keep.json'), 'utf8'), '{"keep":true}');
  assert.equal((await readFile(file('config/data-dir'), 'utf8')).trim(), path.join(root, 'stored-images'));
});
test('existing dotenv credentials are parsed as data and remain byte-for-byte intact', async (t) => {
  const { run, file } = await fixture(t);
  const marker = file('should-not-exist');
  const original = `BASIC_AUTH_USER=personal\nBASIC_AUTH_PASSWORD='$(touch ${marker}) "secret" #value'\n`;
  await writeFile(file('source/.env'), original);
  const result = run('deploy_prepare_environment'); good(result);
  assert.equal(await readFile(file('config/app.env'), 'utf8'), original);
  assert.equal(await exists(marker), false);
  assert.ok(!result.stdout.includes('secret'));
});
test('default ./data uploads are copied to persistent storage before deploying', async (t) => {
  const { run, file } = await fixture(t);
  await mkdir(file('source/data/records'), { recursive: true });
  await writeFile(file('source/data/records/old.json'), 'old annotation');
  good(run('deploy_prepare_environment'));
  assert.equal(await readFile(file('stored-images/records/old.json'), 'utf8'), 'old annotation');
  assert.equal(await readFile(file('source/data/records/old.json'), 'utf8'), 'old annotation');
});
test('an explicitly configured data directory is preserved without merging unused ./data', async (t) => {
  const { run, file } = await fixture(t);
  await mkdir(file('custom-data/records'), { recursive: true });
  await mkdir(file('source/data/records'), { recursive: true });
  await writeFile(file('custom-data/records/current.json'), 'current');
  await writeFile(file('source/data/records/old.json'), 'unused');
  await writeFile(file('source/.env'), `BASIC_AUTH_PASSWORD=existing\nDATA_DIR=${file('custom-data')}\n`);
  good(run('deploy_prepare_environment'));
  assert.equal(await readFile(file('custom-data/records/current.json'), 'utf8'), 'current');
  assert.equal(await exists(file('custom-data/records/old.json')), false);
});
test('data migration refuses to merge two populated stores', async (t) => {
  const { run, file } = await fixture(t);
  await mkdir(file('source/data/records'), { recursive: true });
  await mkdir(file('stored-images/records'), { recursive: true });
  await writeFile(file('source/data/records/a.json'), 'old'); await writeFile(file('stored-images/records/a.json'), 'new');
  const result = run('deploy_prepare_environment'); assert.notEqual(result.status, 0); assert.match(result.stderr, /avoid merging/);
  assert.equal(await readFile(file('stored-images/records/a.json'), 'utf8'), 'new');
});
test('a deployment remembers inputs and refuses accidental domain changes', async (t) => {
  const { run, file } = await fixture(t);
  await writeFile(file('config/domain'), 'annotations.example.com\n'); await writeFile(file('config/email'), 'owner@example.com\n');
  good(run('DEPLOY_DOMAIN=; DEPLOY_EMAIL=; deploy_resolve_inputs; [[ $DEPLOY_DOMAIN == annotations.example.com ]]'));
  const changed = run('DEPLOY_DOMAIN=other.example.com; deploy_resolve_inputs');
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /Change domains manually/);
});
test('Apache configuration preserves Certbot modifications on later deployments', async (t) => {
  const { run, file } = await fixture(t);
  const content = '# Managed by Fretboard Studio deploy.sh\n# Existing HTTPS redirect\n';
  await writeFile(file('apache/sites-available/guitar-annotations.conf'), content);
  good(run('a2enmod() { :; }; a2ensite() { :; }; apache2ctl() { :; }; systemctl() { :; }; ufw() { echo "Status: inactive"; }; deploy_configure_apache'));
  assert.equal(await readFile(file('apache/sites-available/guitar-annotations.conf'), 'utf8'), content);
});
test('an existing unrelated virtual host for the domain is not overwritten', async (t) => {
  const { run, file } = await fixture(t);
  const content = '<VirtualHost *:443>\nServerName annotations.example.com\n</VirtualHost>\n';
  await writeFile(file('apache/sites-enabled/another-app.conf'), content);
  const result = run('deploy_check_apache_site'); assert.notEqual(result.status, 0); assert.match(result.stderr, /already configured/);
  assert.equal(await readFile(file('apache/sites-enabled/another-app.conf'), 'utf8'), content);
});
test('an existing wildcard virtual host for the domain is detected', async (t) => {
  const { run, file } = await fixture(t);
  await writeFile(file('apache/sites-enabled/wildcard.conf'), 'ServerName example.com\nServerAlias *.example.com\n');
  const result = run('deploy_check_apache_site');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /already configured/);
});
test('a failed Apache config test removes only the newly created app virtual host', async (t) => {
  const { run, file } = await fixture(t);
  await writeFile(file('apache/sites-available/existing.conf'), 'existing site');
  const result = run('a2enmod() { :; }; a2ensite() { :; }; a2dissite() { :; }; apache2ctl() { return 1; }; deploy_configure_apache');
  assert.notEqual(result.status, 0);
  assert.equal(await exists(file('apache/sites-available/guitar-annotations.conf')), false);
  assert.equal(await readFile(file('apache/sites-available/existing.conf'), 'utf8'), 'existing site');
});

const activationMocks = `
# GNU mv -T is used on Ubuntu; emulate its rename semantics on the Mac test host.
mv() { "$DEPLOY_NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$2" "$3"; }
systemctl() { :; }
journalctl() { :; }
sleep() { :; }
`;
test('a failed service health check restores the previous release and service configuration', async (t) => {
  const { run, file } = await fixture(t);
  await mkdir(file('app/releases/old')); await mkdir(file('app/releases/new'));
  await symlink(file('app/releases/old'), file('app/current'));
  await writeFile(file('systemd/guitar-annotations.service'), 'previous service');
  const result = run(`${activationMocks}\nDEPLOY_RELEASE=${shellQuote(file('app/releases/new'))}\nDEPLOY_DATA_DIR=${shellQuote(file('stored-images'))}\ncurl() { printf 000; }\ntrap 'deploy_cleanup $?' EXIT\ndeploy_activate_release`);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Restoring/);
  assert.equal(await readlink(file('app/current')), file('app/releases/old'));
  assert.equal(await readFile(file('systemd/guitar-annotations.service'), 'utf8'), 'previous service');
});
test('a healthy release is activated with localhost networking and a persistent data directory', async (t) => {
  const { run, file } = await fixture(t);
  await mkdir(file('app/releases/new'));
  good(run(`${activationMocks}\nDEPLOY_RELEASE=${shellQuote(file('app/releases/new'))}\nDEPLOY_DATA_DIR=${shellQuote(file('stored-images'))}\ncurl() { printf 401; }\ndeploy_activate_release\n[[ $DEPLOY_ACTIVATION_PENDING == 0 ]]`));
  assert.equal(await readlink(file('app/current')), file('app/releases/new'));
  const service = await readFile(file('systemd/guitar-annotations.service'), 'utf8');
  assert.match(service, /Environment=HOST=127\.0\.0\.1/); assert.match(service, /Environment=PORT=3001/);
  assert.ok(service.includes(`Environment=DATA_DIR=${file('stored-images')}`));
});
test('a failed dependency install never switches the running release', async (t) => {
  const { run, file } = await fixture(t);
  await mkdir(file('app/releases/old'));
  await symlink(file('app/releases/old'), file('app/current'));
  await writeFile(file('config/app.env'), 'BASIC_AUTH_PASSWORD=preserve\n');
  const result = run('runuser() { return 42; }; deploy_build_release');
  assert.equal(result.status, 42);
  assert.equal(await readlink(file('app/current')), file('app/releases/old'));
  assert.equal(await readFile(file('config/app.env'), 'utf8'), 'BASIC_AUTH_PASSWORD=preserve\n');
});
test('HTTPS provisioning targets only the app domain and enables automatic renewal', async (t) => {
  const { run, file } = await fixture(t);
  good(run(`certbot() { printf '%s\\n' "$@" > ${shellQuote(file('certbot-args'))}; }
apache2ctl() { :; }
systemctl() { printf '%s\\n' "$*" >> ${shellQuote(file('service-calls'))}; }
curl() { printf 401; }
deploy_configure_https`));
  const args = (await readFile(file('certbot-args'), 'utf8')).trim().split('\n');
  assert.ok(args.includes('--apache')); assert.ok(args.includes('--keep-until-expiring'));
  assert.equal(args[args.indexOf('--domain') + 1], 'annotations.example.com');
  assert.equal(args[args.indexOf('--email') + 1], 'owner@example.com');
  assert.match(await readFile(file('service-calls'), 'utf8'), /enable --now certbot.timer/);
});
