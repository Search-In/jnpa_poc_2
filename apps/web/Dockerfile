# Web (React + ArcGIS + Calcite). Multi-stage: build the Vite bundle against the
# workspace deps, then serve the static `dist/` via nginx. nginx also reverse-
# proxies /gateway/* → the gateway container, matching the Vite dev proxy so the
# LiveAdapter's relative `/gateway` calls work identically in prod.
#
# Build arg DATA_MODE controls whether the bundle boots mock (client-side, zero
# backend) or live (calls the gateway). Defaults to live for the AWS demo stack.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
ENV NODE_OPTIONS="--max-old-space-size=2048"
ARG DATA_MODE=live
ENV DATA_MODE=${DATA_MODE}
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
COPY config ./config
RUN pnpm install --frozen-lockfile=false
# vite resolves workspace deps to source, but the web build's `tsc -b` step
# resolves types via each package's exports → dist, so the dependency graph must
# be built first (same order as the gateway image).
RUN pnpm --filter @jnpa/schemas build \
  && pnpm --filter @jnpa/sim build \
  && pnpm --filter @jnpa/kpi build \
  && pnpm --filter @jnpa/data build \
  && pnpm --filter @jnpa/web build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
