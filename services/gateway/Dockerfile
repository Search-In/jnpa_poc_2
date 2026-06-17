# Gateway (Node/TypeScript). Builds the workspace deps + gateway, runs the BFF.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY config ./config
RUN pnpm install --frozen-lockfile=false
# Build dependency graph (schemas → sim → kpi → data → scenarios/notifications → gateway)
RUN pnpm --filter @jnpa/schemas build \
  && pnpm --filter @jnpa/sim build \
  && pnpm --filter @jnpa/kpi build \
  && pnpm --filter @jnpa/data build \
  && pnpm --filter @jnpa/scenarios build \
  && pnpm --filter @jnpa/notifications build \
  && pnpm --filter @jnpa/gateway build

FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
EXPOSE 8080
CMD ["node", "services/gateway/dist/server.js"]
