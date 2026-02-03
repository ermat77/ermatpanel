#!/bin/sh
set -e

export NGINX_HTTP_PORT="${NGINX_HTTP_PORT:-80}"
export MANAGER_PUBLIC_HOST="${MANAGER_PUBLIC_HOST:-_}"
export LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"

CERTBOT_WEBROOT=/var/www/certbot
LIVE_DIR=/etc/letsencrypt/live

# First domain from MANAGER_PUBLIC_HOST (used for cert path and certbot -d)
get_first_domain() {
    echo "$MANAGER_PUBLIC_HOST" | awk '{print $1}'
}

# Write root_action.conf: either redirect to HTTPS or proxy to manager (must be in snippets, not conf.d)
write_root_action() {
    if [ "$1" = "redirect" ]; then
        echo 'return 302 https://$host$request_uri;' > /etc/nginx/snippets/root_action.conf
    else
        echo 'include /etc/nginx/snippets/proxy_snippet.conf;' > /etc/nginx/snippets/root_action.conf
    fi
}

# Generate default.conf from template
write_default_conf() {
    envsubst '${NGINX_HTTP_PORT} ${MANAGER_PUBLIC_HOST}' \
        < /etc/nginx/templates/default.conf.template \
        > /etc/nginx/conf.d/default.conf
}

# Generate ssl.conf from template
write_ssl_conf() {
    envsubst '${MANAGER_PUBLIC_HOST} ${LETSENCRYPT_LIVE}' \
        < /etc/nginx/templates/ssl.conf.template \
        > /etc/nginx/conf.d/ssl.conf
}

if [ -z "$LETSENCRYPT_EMAIL" ]; then
    # No Let's Encrypt: HTTP only, proxy to manager
    write_root_action proxy
    write_default_conf
    exec nginx -g "daemon off;"
fi

# Let's Encrypt enabled
FIRST_DOMAIN=$(get_first_domain)
if [ -z "$FIRST_DOMAIN" ] || [ "$FIRST_DOMAIN" = "_" ]; then
    echo "LETSENCRYPT_EMAIL is set but MANAGER_PUBLIC_HOST is missing or wildcard. Need a real hostname for certificates."
    write_root_action proxy
    write_default_conf
    exec nginx -g "daemon off;"
fi

export LETSENCRYPT_LIVE="$LIVE_DIR/$FIRST_DOMAIN"
CERT_FILE="$LETSENCRYPT_LIVE/fullchain.pem"

if [ ! -f "$CERT_FILE" ]; then
    # Initial certificate: use standalone (port 80 must be free)
    STAGING=""
    [ -n "$LETSENCRYPT_STAGING" ] && [ "$LETSENCRYPT_STAGING" != "0" ] && STAGING="--staging"
    echo "Obtaining initial certificate for $FIRST_DOMAIN ..."
    certbot certonly \
        $STAGING \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "$LETSENCRYPT_EMAIL" \
        -d "$FIRST_DOMAIN"
fi

if [ -f "$CERT_FILE" ]; then
    write_root_action redirect
    write_ssl_conf
else
    write_root_action proxy
fi
write_default_conf

# Background: renew certs periodically and reload nginx
renew_loop() {
    while true; do
        sleep 43200
        certbot renew --webroot -w "$CERTBOT_WEBROOT" && nginx -s reload 2>/dev/null || true
    done
}
renew_loop &

exec nginx -g "daemon off;"
