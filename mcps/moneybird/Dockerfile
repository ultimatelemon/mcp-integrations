# Build context is the repository root: docker build -f mcps/moneybird/Dockerfile .
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY mcps/moneybird/package.json mcps/moneybird/
RUN npm ci --workspace mcps/moneybird --include-workspace-root=false
COPY mcps/moneybird/tsconfig.json mcps/moneybird/tsconfig.build.json mcps/moneybird/
COPY mcps/moneybird/src mcps/moneybird/src
RUN npm run build --workspace mcps/moneybird \
  && npm prune --omit=dev --workspace mcps/moneybird --include-workspace-root=false

FROM node:24.21.0-alpine3.24 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/mcps/moneybird/package.json ./
COPY --from=build --chown=node:node /build/mcps/moneybird/dist ./dist
# Read at runtime by find_moneybird_endpoint and moneybird_api.
COPY --chown=node:node mcps/moneybird/spec/endpoints.json ./spec/endpoints.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.BASE_PATH||'')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
