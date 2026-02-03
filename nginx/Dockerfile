# ============================================================
# Nginx reverse proxy for Hytale Manager
# ============================================================
# Serves the manager frontend at a configurable URL (domain or IP).
# With LETSENCRYPT_EMAIL set: obtains and renews Let's Encrypt certs (HTTPS).
# ============================================================

FROM nginx:alpine

# envsubst for template substitution; certbot for Let's Encrypt
RUN apk add --no-cache gettext certbot

# Remove default config so our generated config is used
RUN rm -f /etc/nginx/conf.d/default.conf

# Certbot webroot for HTTP-01 challenges (renewal)
RUN mkdir -p /var/www/certbot

# Templates: processed by entrypoint. Snippets in a dir nginx does not auto-include.
RUN mkdir -p /etc/nginx/snippets
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY ssl.conf.template /etc/nginx/templates/ssl.conf.template
COPY proxy_snippet.conf /etc/nginx/snippets/proxy_snippet.conf
COPY hello.html /usr/share/nginx/html/hello.html

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
