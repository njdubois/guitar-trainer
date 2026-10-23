# Deploy on Ubuntu with Apache

Use `deploy.sh` from a complete copy of this repository on Ubuntu **22.04,
24.04, or 26.04 LTS**. It installs the app using Node, Apache, systemd, and Certbot.

## Before running

- Point a dedicated hostname, such as `annotations.yourdomain.com`, at this
  server. Any A and AAAA records must point to this server.
- Allow inbound TCP ports 80 and 443 in your hosting provider's firewall.
- Use an account with sudo access. The script needs systemd.

End-of-life interim releases such as Ubuntu 22.10 (`kinetic`) are rejected before
installing packages. This script does not upgrade Ubuntu or rewrite package
repository codenames. If apt reports `kinetic` mirror 404 errors, check
`cat /etc/os-release` and plan an OS upgrade/migration, or repair stale repository
settings if the OS has already been upgraded. See Ubuntu's
[release list](https://ubuntu.com/project/docs/release-team/list-of-releases/) and
[end-of-life upgrade guide](https://help.ubuntu.com/community/EOLUpgrades).

The script enables the `Apache Full` UFW rule if UFW is already active. It does
not enable UFW or change SSH rules. It creates one dedicated Apache virtual
host. If the chosen hostname is already covered by another enabled virtual
host, including a wildcard alias, it stops and explains the conflict.

## Run the deployment

In your server copy of the repository:

```bash
sudo bash deploy.sh
```

It asks for the hostname and the email for certificate notices. You can also
provide these up front:

```bash
sudo bash deploy.sh --domain annotations.yourdomain.com --email you@yourdomain.com
```

Certbot may ask you to accept Let's Encrypt's terms on the first certificate
request. At completion, the script prints the HTTPS URL and, on a new install,
the generated login password. The initial username is `annotator`.

## What the script does

1. Installs Apache, its proxy/SSL modules, Certbot's Apache integration, and
   build tools. Installs system Node 24 if `/usr/bin/node` is missing or older
   than 22.12.
2. Creates the dedicated `guitar-ar` system account.
3. Preserves an existing deployment's `.env`, or generates a new password.
4. Keeps uploads in persistent storage. If a previous install used `./data`,
   it copies that data to the persistent location without deleting the original.
   Conflicting populated stores are not merged automatically.
5. Installs dependencies and builds React in a new release folder before
   switching the service to it.
6. Configures systemd, starts the app on localhost port 3001, and checks the
   password challenge. A failed service health check restores the prior release
   and service file.
7. Enables a dedicated Apache proxy, obtains or reuses an HTTPS certificate,
   enables its renewal timer, and checks the HTTPS password challenge.

Other virtual host files are not edited. Repeated deployments preserve this
app's existing Apache redirects and certificate configuration. Old release
folders are retained; uploaded data is stored separately.

## Deploy later changes

From your server's Git checkout:

```bash
git pull --ff-only
sudo bash deploy.sh
```

The hostname, certificate email, credentials, and storage location are reused.
You can also rerun the script after an interrupted or failed deployment. Check
the reported error first, particularly DNS or firewall issues during HTTPS
setup.

The installer also copies itself into each deployed release, so if you uploaded
a source archive rather than using Git, you can run the script from your newer
uploaded source directory in the same way.

## Files on the server

| Location | Purpose |
| --- | --- |
| `/opt/guitar-annotation-tool/releases/` | Built releases and their dependencies |
| `/opt/guitar-annotation-tool/current` | Symlink to the active release |
| `/etc/guitar-annotations/app.env` | Preserved or generated app credentials |
| `/etc/guitar-annotations/domain` | Saved hostname |
| `/etc/guitar-annotations/email` | Saved certificate email |
| `/etc/guitar-annotations/data-dir` | Persistent upload directory |
| `/var/lib/guitar-annotations/` | Default upload and annotation storage |
| `/etc/apache2/sites-available/guitar-annotations.conf` | App's Apache virtual host |
| `/etc/systemd/system/guitar-annotations.service` | App's systemd service |

An explicitly configured existing `DATA_DIR` is reused. The service binds to
localhost port 3001 regardless of old HOST/PORT settings in `.env`.

## Change your password

```bash
sudo nano /etc/guitar-annotations/app.env
sudo systemctl restart guitar-annotations
```

Update `BASIC_AUTH_PASSWORD`. The script does not reset it on later deployments.
If a first deployment stopped before displaying its generated password, read
this file to retrieve it.

## Logs and backups

```bash
sudo systemctl status guitar-annotations --no-pager
sudo journalctl -u guitar-annotations -n 50 --no-pager
```

Back up the entire persistent data folder and `/etc/guitar-annotations/`.

## Manual Apache setup

`deploy/apache.conf` is the Apache virtual host template if you prefer manual
configuration. The older `deploy/guitar-annotations.service` example is for a
manual installation directly under `/opt/guitar-annotation-tool`; the script
generates its own service for the release layout described above.

## Verification

`npm test` includes deployment checks for credential preservation, data
migration, malformed inputs, Apache configuration preservation, failed builds,
service rollback, and certificate command construction. System commands are
simulated by these tests; actual package installation, Apache/systemd operation,
and certificate issuance must run on the Ubuntu server. `shellcheck deploy.sh`
and `bash -n deploy.sh` check the script itself.

References: [Apache reverse proxies](https://httpd.apache.org/docs/2.4/mod/mod_proxy.html),
[Certbot Apache instructions](https://certbot.eff.org/instructions?ws=apache&os=ubuntufocal),
[NodeSource installer](https://github.com/nodesource/distributions/blob/master/scripts/deb/setup_24.x).
