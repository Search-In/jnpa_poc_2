# Gateway (Node/TypeScript).
# Since it is built on the CI runner, we only need to copy the pre-built files and install production deps.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY config ./config
RUN pnpm install --frozen-lockfile=false --prod
EXPOSE 8080
CMD ["node", "services/gateway/dist/server.js"]

