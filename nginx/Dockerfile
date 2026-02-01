# ============================================================
# Nginx reverse proxy for Hytale Manager
# ============================================================
# Serves the manager frontend at a configurable URL (domain or IP).
# Config is generated at runtime from env (MANAGER_PUBLIC_HOST, NGINX_HTTP_PORT).
# ============================================================

FROM nginx:alpine

# envsubst for template substitution (only our env vars; nginx vars like $host stay literal)
RUN apk add --no-cache gettext

# Remove default config so our generated config is used
RUN rm -f /etc/nginx/conf.d/default.conf

# Template will be processed by entrypoint and written to conf.d
COPY default.conf.template /etc/nginx/templates/default.conf.template
# Static test page for connectivity checks (see /hello in config)
COPY hello.html /usr/share/nginx/html/hello.html

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
# Optional: 443 for future HTTPS
# EXPOSE 443

ENTRYPOINT ["/entrypoint.sh"]
