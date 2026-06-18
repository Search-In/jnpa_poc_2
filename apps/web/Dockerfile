# Web (React + ArcGIS + Calcite).
# Since it is built on the CI runner, we only need Nginx to serve the static dist.
FROM nginx:1.27-alpine
COPY apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

