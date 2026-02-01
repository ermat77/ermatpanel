#!/bin/sh
set -e
# Defaults: port 80, default_server (accept any host) when MANAGER_PUBLIC_HOST not set
export NGINX_HTTP_PORT="${NGINX_HTTP_PORT:-80}"
export MANAGER_PUBLIC_HOST="${MANAGER_PUBLIC_HOST:-_}"
# Substitute only our env vars so nginx variables ($host, $remote_addr, etc.) stay literal
envsubst '${NGINX_HTTP_PORT} ${MANAGER_PUBLIC_HOST}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf
exec nginx -g "daemon off;"
