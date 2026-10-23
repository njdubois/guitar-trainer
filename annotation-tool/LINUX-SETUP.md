# Set up on Ubuntu 24.04

This guide uses a Node process, systemd, and Nginx. You need an SSH account
with sudo access and a domain/subdomain pointing to your server.

Replace `SERVER_USER`, `SERVER_IP`, and `annotations.example.com` below with
your actual SSH username, public server IP, and domain.

## 1. Point your domain at the server

Create an A record for your chosen hostname, such as `annotations`, pointing
to the server's public IPv4 address. In your hosting provider's firewall, allow
inbound TCP ports 80 and 443. The app itself will listen on localhost port 3001.

Use a dedicated hostname, such as `annotations.yourdomain.com`; this version
serves from the hostname root.

## 2. Upload the project from your Mac

From a Mac terminal, package the source:

```bash
cd /Users/nickdubois/www/PersonalProjects/new_guitar_ar/annotation-tool
tar --exclude=node_modules --exclude=dist --exclude=data --exclude=.env --exclude=test-results --exclude=playwright-report -czf /tmp/guitar-annotation-tool.tar.gz .
scp /tmp/guitar-annotation-tool.tar.gz SERVER_USER@SERVER_IP:~/
ssh SERVER_USER@SERVER_IP
```

Mac-installed `node_modules` must stay out of the upload; npm installs the
correct Linux packages on the server. Existing annotation data and passwords
are also excluded from this source archive.

Run the remaining commands on the Linux server.

## 3. Install the server software

```bash
sudo apt update
sudo apt install -y curl ca-certificates nginx certbot python3-certbot-nginx
```

Check Node if it is already installed:

```bash
node --version
```

The app requires Node 22.12 or newer. If it is missing or older, install
Node 24 using the NodeSource package repository:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node --version
```

These service instructions expect the system Node executable at `/usr/bin/node`.
Check `command -v node`; if your existing Node is installed elsewhere, update
`ExecStart` in the service file to its absolute path.

## 4. Install and build the application

Create a dedicated application account, application folder, and data folder:

```bash
sudo useradd --system --user-group --home-dir /opt/guitar-annotation-tool --shell /usr/sbin/nologin guitar-ar
sudo mkdir -p /opt/guitar-annotation-tool /var/lib/guitar-annotations
sudo tar -xzf ~/guitar-annotation-tool.tar.gz -C /opt/guitar-annotation-tool
sudo chown -R guitar-ar:guitar-ar /opt/guitar-annotation-tool /var/lib/guitar-annotations
cd /opt/guitar-annotation-tool
sudo -H -u guitar-ar npm ci --include=dev
sudo -H -u guitar-ar npm run build
```

## 5. Set the password

```bash
sudo -u guitar-ar cp .env.example .env
sudo -u guitar-ar nano .env
```

Use these values, replacing the sample password:

```dotenv
PORT=3001
HOST=127.0.0.1
BASIC_AUTH_USER=annotator
BASIC_AUTH_PASSWORD="choose-your-password"
DATA_DIR=/var/lib/guitar-annotations
```

In nano, press Ctrl+O, Enter to save, then Ctrl+X to exit.

```bash
sudo chmod 600 .env
```

## 6. Start the app and keep it running

```bash
sudo cp deploy/guitar-annotations.service /etc/systemd/system/guitar-annotations.service
sudo systemctl daemon-reload
sudo systemctl enable --now guitar-annotations
sudo systemctl status guitar-annotations --no-pager
```

Look for `active (running)`. Check the local app:

```bash
curl -I http://127.0.0.1:3001/
```

`401 Unauthorized` is expected: it confirms the app is responding and enforcing
its password. If startup fails, inspect logs with:

```bash
sudo journalctl -u guitar-annotations -n 50 --no-pager
```

## 7. Connect your domain

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/guitar-annotations
sudo nano /etc/nginx/sites-available/guitar-annotations
```

Replace `annotations.example.com` in `server_name` with your actual hostname.
Save and exit. Then:

```bash
sudo ln -s /etc/nginx/sites-available/guitar-annotations /etc/nginx/sites-enabled/guitar-annotations
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Only reload after `nginx -t` succeeds. If UFW is already active, allow the web
ports without changing your SSH rules:

```bash
sudo ufw allow 'Nginx Full'
```

## 8. Enable HTTPS and sign in

The hostname must resolve to this server and port 80 must be reachable for
certificate validation. Replace the hostname in this command:

```bash
sudo certbot --nginx --redirect -d annotations.example.com
sudo certbot renew --dry-run
```

Follow Certbot's email and terms prompts. Open your HTTPS address, for example
`https://annotations.yourdomain.com`, and sign in using `annotator` and the
password you set in `.env`.

## Ongoing use

Restart after changing `.env`:

```bash
sudo systemctl restart guitar-annotations
```

View live logs:

```bash
sudo journalctl -u guitar-annotations -f
```

Images and annotations persist in `/var/lib/guitar-annotations`. Back up that
entire directory. The source code lives separately in `/opt/guitar-annotation-tool`.

For later source updates, preserve `.env` and the data folder, replace the
application source, repeat `npm ci --include=dev` and `npm run build` as the
`guitar-ar` user, then restart the service. Run one server process for this
file-backed version.

References: [NodeSource installation](https://github.com/nodesource/distributions),
[Nginx proxy settings](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[Ubuntu's Certbot Nginx package](https://packages.ubuntu.com/noble/python3-certbot-nginx),
[Certbot Nginx instructions](https://certbot.eff.org/instructions?ws=nginx&os=snap).
