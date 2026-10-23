#!/usr/bin/env bash
# Deploy Fretboard Studio on Ubuntu 22.04+ with Apache and systemd.
# Usage: sudo bash deploy.sh --domain annotations.example.com --email you@example.com

DEPLOY_APP_ROOT=/opt/guitar-annotation-tool
DEPLOY_CONFIG_DIR=/etc/guitar-annotations
DEPLOY_APACHE_ROOT=/etc/apache2
DEPLOY_SYSTEMD_DIR=/etc/systemd/system
DEPLOY_DEFAULT_DATA=/var/lib/guitar-annotations
DEPLOY_CACHE_DIR=/var/cache/guitar-annotations
DEPLOY_USER=guitar-ar
DEPLOY_SERVICE=guitar-annotations
DEPLOY_PORT=3001
DEPLOY_NODE=/usr/bin/node
DEPLOY_DOMAIN=
DEPLOY_EMAIL=
DEPLOY_TEMP=
DEPLOY_NEW_PASSWORD=
DEPLOY_PREVIOUS_RELEASE=
DEPLOY_ACTIVATION_PENDING=0

deploy_log() { printf '\n[deploy] %s\n' "$*"; }
deploy_die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

deploy_usage() {
  cat <<'USAGE'
Deploy Fretboard Studio on Ubuntu 22.04 or newer, using Apache.

  sudo bash deploy.sh
  sudo bash deploy.sh --domain annotations.example.com --email you@example.com

Options:
  --domain HOSTNAME   Dedicated hostname already pointing at this server.
  --email EMAIL      Email for Let's Encrypt certificate notices.
  -h, --help         Show this help without changing anything.

The first run prompts for missing values and generates an application password.
Later runs reuse the saved domain, email, password, and image storage location.
Certbot may ask you to accept its terms on the first certificate request.
Allow incoming ports 80 and 443 in your hosting provider's firewall before running.
USAGE
}

deploy_parse_args() {
  while (($#)); do
    case "$1" in
      --domain) [[ $# -ge 2 && -n $2 ]] || deploy_die '--domain needs a hostname.'; DEPLOY_DOMAIN=$2; shift 2 ;;
      --email) [[ $# -ge 2 && -n $2 ]] || deploy_die '--email needs an email address.'; DEPLOY_EMAIL=$2; shift 2 ;;
      -h|--help) deploy_usage; exit 0 ;;
      *) deploy_die "Unknown option: $1. Use --help." ;;
    esac
  done
}

deploy_validate_domain() {
  local deploy_label
  [[ ${#1} -le 253 && $1 == *.* && $1 != *..* && $1 != *[!a-zA-Z0-9.-]* ]] || return 1
  local IFS=.
  for deploy_label in $1; do
    [[ -n $deploy_label && ${#deploy_label} -le 63 && $deploy_label != -* && $deploy_label != *- ]] || return 1
  done
  [[ $1 != .* && $1 != *. && ! $1 =~ ^[0-9.]+$ ]]
}

deploy_validate_email() {
  [[ $1 =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ && $1 != -* ]]
}

deploy_resolve_inputs() {
  local deploy_previous_domain=
  if [[ -f $DEPLOY_CONFIG_DIR/domain ]]; then deploy_previous_domain=$(cat "$DEPLOY_CONFIG_DIR/domain"); fi
  DEPLOY_DOMAIN=${DEPLOY_DOMAIN:-$deploy_previous_domain}
  if [[ -z $DEPLOY_EMAIL && -f $DEPLOY_CONFIG_DIR/email ]]; then DEPLOY_EMAIL=$(cat "$DEPLOY_CONFIG_DIR/email"); fi
  if [[ -z $DEPLOY_DOMAIN ]]; then
    [[ -t 0 ]] || deploy_die 'Supply --domain when running without a terminal.'
    read -r -p 'Domain for this app (for example annotations.yourdomain.com): ' DEPLOY_DOMAIN
  fi
  if [[ -z $DEPLOY_EMAIL ]]; then
    [[ -t 0 ]] || deploy_die 'Supply --email when running without a terminal.'
    read -r -p "Email for the HTTPS certificate: " DEPLOY_EMAIL
  fi
  DEPLOY_DOMAIN=$(printf '%s' "$DEPLOY_DOMAIN" | tr '[:upper:]' '[:lower:]')
  deploy_validate_domain "$DEPLOY_DOMAIN" || deploy_die 'Enter a hostname only, without https://, a port, or a path.'
  deploy_validate_email "$DEPLOY_EMAIL" || deploy_die 'Enter a valid certificate email address.'
  if [[ -n $deploy_previous_domain && $DEPLOY_DOMAIN != "$deploy_previous_domain" ]]; then
    deploy_die "This installation uses $deploy_previous_domain. Change domains manually before redeploying."
  fi
}

deploy_check_platform() {
  [[ $(uname -s) == Linux ]] || deploy_die 'Run this script on the Ubuntu server, not on your Mac.'
  [[ $EUID -eq 0 ]] || deploy_die 'Run with sudo: sudo bash deploy.sh'
  # /etc/os-release is supplied by the operating system, not the application.
  # shellcheck disable=SC1091
  . /etc/os-release
  local deploy_version=${VERSION_ID:-0}
  [[ ${ID:-} == ubuntu && ${deploy_version%%.*} -ge 22 ]] || deploy_die 'This installer supports Ubuntu 22.04 and newer.'
  [[ -d /run/systemd/system ]] || deploy_die 'This installer needs a server running systemd.'
  command -v flock >/dev/null || deploy_die 'Install util-linux so the deployment can acquire a lock.'
}

deploy_install_packages() {
  deploy_log 'Installing Apache, Certbot, and build tools.'
  apt-get update
  env DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold \
    apache2 certbot python3-certbot-apache curl ca-certificates rsync openssl
  if ! "$DEPLOY_NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' 2>/dev/null; then
    deploy_log 'Installing system Node.js 24 from NodeSource.'
    curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 \
      https://deb.nodesource.com/setup_24.x -o "$DEPLOY_TEMP/nodesource.sh"
    bash "$DEPLOY_TEMP/nodesource.sh"
    env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  "$DEPLOY_NODE" --version
}

deploy_prepare_account() {
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DEPLOY_APP_ROOT" --shell /usr/sbin/nologin "$DEPLOY_USER"
  fi
  getent group "$DEPLOY_USER" >/dev/null || deploy_die "The $DEPLOY_USER user must have a matching group."
  install -d -m 755 "$DEPLOY_APP_ROOT" "$DEPLOY_APP_ROOT/releases"
  install -d -m 750 -o root -g "$DEPLOY_USER" "$DEPLOY_CONFIG_DIR"
  install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_CACHE_DIR"
}

deploy_validate_data_dir() {
  [[ $1 == /* && $1 != *[!a-zA-Z0-9_./-]* ]] || return 1
  case "$1" in
    /|/etc|/var|/var/lib|/srv|/opt|/home|/root|/usr|/usr/local|/tmp|/var/tmp|"$DEPLOY_APP_ROOT"|"$DEPLOY_CONFIG_DIR") return 1 ;;
  esac
  [[ ! $1 =~ ^/home/[^/]+$ ]]
}

deploy_prepare_environment() {
  local deploy_env="$DEPLOY_CONFIG_DIR/app.env" deploy_legacy_base="$DEPLOY_SOURCE_DIR" deploy_data deploy_migrate_data=0
  if [[ ! -f $deploy_env ]]; then
    if [[ -f $DEPLOY_APP_ROOT/.env ]]; then
      install -m 640 -o root -g "$DEPLOY_USER" "$DEPLOY_APP_ROOT/.env" "$deploy_env"
      deploy_legacy_base=$DEPLOY_APP_ROOT
    elif [[ -f $DEPLOY_SOURCE_DIR/.env ]]; then
      install -m 640 -o root -g "$DEPLOY_USER" "$DEPLOY_SOURCE_DIR/.env" "$deploy_env"
    else
      DEPLOY_NEW_PASSWORD=$(openssl rand -hex 20)
      (umask 077; printf 'BASIC_AUTH_USER=annotator\nBASIC_AUTH_PASSWORD=%s\n' "$DEPLOY_NEW_PASSWORD" > "$deploy_env")
    fi
  fi
  chown "root:$DEPLOY_USER" "$deploy_env"
  chmod 640 "$deploy_env"
  # Parse dotenv as data. Never source passwords or application settings as shell code.
  "$DEPLOY_NODE" "$DEPLOY_SOURCE_DIR/deploy/read-env.mjs" "$deploy_env" validate
  if [[ -f $DEPLOY_CONFIG_DIR/data-dir ]]; then
    deploy_data=$(cat "$DEPLOY_CONFIG_DIR/data-dir")
  else
    deploy_data=$("$DEPLOY_NODE" "$DEPLOY_SOURCE_DIR/deploy/read-env.mjs" "$deploy_env" data-dir)
    if [[ -z $deploy_data ]]; then deploy_data=$DEPLOY_DEFAULT_DATA; deploy_migrate_data=1
    elif [[ $deploy_data != /* ]]; then deploy_data="$deploy_legacy_base/$deploy_data"; fi
  fi
  deploy_data=$(realpath -m "$deploy_data")
  deploy_validate_data_dir "$deploy_data" || deploy_die "Use a dedicated, absolute data folder without spaces: $deploy_data"
  DEPLOY_DATA_DIR=$deploy_data
  install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_DATA_DIR"
  # Preserve data from an earlier manual deployment which used the default ./data.
  if [[ $deploy_migrate_data == 1 && -d $deploy_legacy_base/data && $deploy_legacy_base/data != "$DEPLOY_DATA_DIR" ]]; then
    if [[ -n $(find "$deploy_legacy_base/data" -type f -print -quit) ]]; then
      [[ -z $(find "$DEPLOY_DATA_DIR" -type f -print -quit) ]] || deploy_die 'Both the previous and new data folders contain files; move the data manually to avoid merging conflicting annotations.'
      rsync -a "$deploy_legacy_base/data/" "$DEPLOY_DATA_DIR/"
    fi
  fi
  local deploy_kind
  for deploy_kind in records images thumbnails; do
    install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_DATA_DIR/$deploy_kind"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_DATA_DIR/$deploy_kind"
  done
  printf '%s\n' "$DEPLOY_DATA_DIR" > "$DEPLOY_CONFIG_DIR/data-dir"
  printf '%s\n' "$DEPLOY_DOMAIN" > "$DEPLOY_CONFIG_DIR/domain"
  printf '%s\n' "$DEPLOY_EMAIL" > "$DEPLOY_CONFIG_DIR/email"
}

deploy_build_release() {
  deploy_log 'Building a new release. The running app stays in place until the build succeeds.'
  DEPLOY_RELEASE="$DEPLOY_APP_ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir "$DEPLOY_RELEASE"
  rsync -a --exclude=.git --exclude=.env --exclude=node_modules --exclude=dist --exclude=data \
    --exclude=test-results --exclude=playwright-report --exclude=releases --exclude=current \
    "$DEPLOY_SOURCE_DIR/" "$DEPLOY_RELEASE/"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_RELEASE"
  (
    cd "$DEPLOY_RELEASE"
    runuser -u "$DEPLOY_USER" -- env npm_config_cache="$DEPLOY_CACHE_DIR" /usr/bin/npm ci --include=dev --no-fund
    runuser -u "$DEPLOY_USER" -- env npm_config_cache="$DEPLOY_CACHE_DIR" /usr/bin/npm run build
  )
  [[ -f $DEPLOY_RELEASE/dist/index.html ]] || deploy_die 'The React build did not produce dist/index.html.'
  ln -s "$DEPLOY_CONFIG_DIR/app.env" "$DEPLOY_RELEASE/.env"
}

deploy_render_service() {
  cat <<SERVICE
[Unit]
Description=Guitar AR annotation tool
After=network.target

[Service]
Type=simple
User=$DEPLOY_USER
Group=$DEPLOY_USER
WorkingDirectory=$DEPLOY_APP_ROOT/current
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$DEPLOY_PORT
Environment=DATA_DIR=$DEPLOY_DATA_DIR
ExecStart=$DEPLOY_NODE $DEPLOY_APP_ROOT/current/server/index.js
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
SERVICE
}

deploy_activate_release() {
  local deploy_current="$DEPLOY_APP_ROOT/current" deploy_unit="$DEPLOY_SYSTEMD_DIR/$DEPLOY_SERVICE.service"
  [[ ! -e $deploy_current || -L $deploy_current ]] || deploy_die "$deploy_current must be a symlink, not a directory."
  if [[ -L $deploy_current ]]; then DEPLOY_PREVIOUS_RELEASE=$(readlink "$deploy_current"); fi
  if [[ -f $deploy_unit ]]; then cp -p "$deploy_unit" "$DEPLOY_TEMP/service.before"; fi
  DEPLOY_ACTIVATION_PENDING=1
  deploy_render_service > "$DEPLOY_TEMP/service.new"
  install -m 644 "$DEPLOY_TEMP/service.new" "$deploy_unit"
  ln -s "$DEPLOY_RELEASE" "$DEPLOY_APP_ROOT/.current-$$"
  mv -Tf "$DEPLOY_APP_ROOT/.current-$$" "$deploy_current"
  systemctl daemon-reload
  systemctl enable "$DEPLOY_SERVICE"
  systemctl restart "$DEPLOY_SERVICE"
  local deploy_attempt deploy_status
  for ((deploy_attempt = 1; deploy_attempt <= 30; deploy_attempt++)); do
    deploy_status=$(curl --silent --max-time 3 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$DEPLOY_PORT/api/config" || true)
    if [[ $deploy_status == 401 ]] && systemctl is-active --quiet "$DEPLOY_SERVICE"; then
      DEPLOY_ACTIVATION_PENDING=0
      return
    fi
    sleep 1
  done
  journalctl -u "$DEPLOY_SERVICE" -n 30 --no-pager >&2 || true
  deploy_die 'The new service did not become healthy. Restoring the previous service.'
}

deploy_check_apache_site() {
  local deploy_available="$DEPLOY_APACHE_ROOT/sites-available/$DEPLOY_SERVICE.conf" deploy_site
  if [[ -f $deploy_available ]] && ! grep -q '^# Managed by Fretboard Studio deploy.sh$' "$deploy_available"; then
    deploy_die "$deploy_available already exists and is not managed by this script. Keep it and choose a manual Apache setup."
  fi
  for deploy_site in "$DEPLOY_APACHE_ROOT/sites-enabled/"*.conf; do
    [[ -f $deploy_site ]] || continue
    case "${deploy_site##*/}" in "$DEPLOY_SERVICE.conf"|"$DEPLOY_SERVICE-le-ssl.conf") continue ;; esac
    if awk -v domain="$DEPLOY_DOMAIN" '
      tolower($1) == "servername" || tolower($1) == "serveralias" {
        for (i = 2; i <= NF; i++) {
          value = tolower($i); gsub(/"/, "", value)
          gsub(/\./, "\\.", value); gsub(/\*/, ".*", value); gsub(/\?/, ".", value)
          if (domain ~ ("^" value "$")) found = 1
        }
      } END { exit !found }' "$deploy_site"; then
      deploy_die "$DEPLOY_DOMAIN is already configured in $deploy_site. Use a dedicated subdomain or adapt that virtual host manually."
    fi
  done
}

deploy_configure_apache() {
  deploy_log 'Configuring the dedicated Apache virtual host.'
  local deploy_available="$DEPLOY_APACHE_ROOT/sites-available/$DEPLOY_SERVICE.conf" deploy_created=0
  a2enmod proxy proxy_http headers ssl rewrite
  # Do not overwrite Certbot redirects or an existing HTTPS virtual host on updates.
  if [[ ! -f $deploy_available ]]; then
    sed "s/annotations.example.com/$DEPLOY_DOMAIN/g" "$DEPLOY_SOURCE_DIR/deploy/apache.conf" > "$DEPLOY_TEMP/apache.new"
    install -m 644 "$DEPLOY_TEMP/apache.new" "$deploy_available"
    deploy_created=1
  fi
  a2ensite "$DEPLOY_SERVICE.conf"
  if ! apache2ctl configtest; then
    if [[ $deploy_created == 1 ]]; then a2dissite "$DEPLOY_SERVICE.conf"; rm -f "$deploy_available"; fi
    deploy_die 'Apache configuration test failed. Existing virtual host files were preserved.'
  fi
  systemctl enable --now apache2
  systemctl reload apache2
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 'Apache Full'; fi
}

deploy_configure_https() {
  deploy_log 'Obtaining or reusing the HTTPS certificate. Certbot may prompt on its first run.'
  certbot --apache --redirect --keep-until-expiring --cert-name "$DEPLOY_DOMAIN" \
    --domain "$DEPLOY_DOMAIN" --email "$DEPLOY_EMAIL"
  apache2ctl configtest
  systemctl reload apache2
  systemctl enable --now certbot.timer
  local deploy_status
  deploy_status=$(curl --silent --show-error --max-time 15 --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' "https://$DEPLOY_DOMAIN/api/config")
  [[ $deploy_status == 401 ]] || deploy_die "HTTPS health check returned $deploy_status, expected the password challenge (401)."
}

deploy_cleanup() {
  local deploy_exit=$1
  set +e
  if [[ $deploy_exit != 0 && $DEPLOY_ACTIVATION_PENDING == 1 ]]; then
    printf '\nRestoring the previous application service.\n' >&2
    if [[ -n $DEPLOY_PREVIOUS_RELEASE ]]; then
      ln -sfn "$DEPLOY_PREVIOUS_RELEASE" "$DEPLOY_APP_ROOT/current"
    else
      rm -f "$DEPLOY_APP_ROOT/current"
    fi
    if [[ -f $DEPLOY_TEMP/service.before ]]; then
      cp -p "$DEPLOY_TEMP/service.before" "$DEPLOY_SYSTEMD_DIR/$DEPLOY_SERVICE.service"
      systemctl daemon-reload
      systemctl restart "$DEPLOY_SERVICE" || true
    else
      systemctl stop "$DEPLOY_SERVICE" || true
      systemctl disable "$DEPLOY_SERVICE" || true
      rm -f "$DEPLOY_SYSTEMD_DIR/$DEPLOY_SERVICE.service"
      systemctl daemon-reload
    fi
  fi
  [[ -z $DEPLOY_TEMP ]] || rm -rf -- "$DEPLOY_TEMP"
  if [[ $deploy_exit != 0 ]]; then
    printf '\nDeployment did not complete. Fix the reported error and rerun the same command.\nApp credentials and uploaded data are preserved.\n' >&2
  fi
}

deploy_main() {
  deploy_parse_args "$@"
  deploy_check_platform
  DEPLOY_SOURCE_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  [[ -f $DEPLOY_SOURCE_DIR/package-lock.json && -f $DEPLOY_SOURCE_DIR/server/index.js && -f $DEPLOY_SOURCE_DIR/deploy/apache.conf ]] || deploy_die 'Run the script from a complete copy of the annotation-tool repository.'
  exec 9>/run/lock/guitar-annotations-deploy.lock
  flock -n 9 || deploy_die 'Another deployment is already running.'
  deploy_resolve_inputs
  deploy_check_apache_site
  getent hosts "$DEPLOY_DOMAIN" >/dev/null || deploy_die 'The domain does not resolve. Set up its DNS record first.'
  DEPLOY_TEMP=$(mktemp -d /tmp/guitar-annotations-deploy.XXXXXX)
  trap 'deploy_cleanup $?' EXIT
  deploy_install_packages
  deploy_prepare_account
  deploy_prepare_environment
  deploy_build_release
  deploy_log 'Starting the application service and checking password protection.'
  deploy_activate_release
  deploy_configure_apache
  deploy_configure_https
  deploy_log "Deployment complete: https://$DEPLOY_DOMAIN"
  if [[ -n $DEPLOY_NEW_PASSWORD ]]; then
    printf 'Username: annotator\nPassword: %s\nSave this password.\n' "$DEPLOY_NEW_PASSWORD"
  else
    printf 'Your existing login credentials were preserved.\n'
  fi
  printf 'Credentials: %s/app.env\nUploads and annotations: %s\n' "$DEPLOY_CONFIG_DIR" "$DEPLOY_DATA_DIR"
  printf 'Logs: sudo journalctl -u %s -f\n' "$DEPLOY_SERVICE"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -Eeuo pipefail
  umask 022
  deploy_main "$@"
fi
