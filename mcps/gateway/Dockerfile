# Build context is the repository root: docker build -f mcps/gateway/Dockerfile .
FROM node:26-alpine AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY mcps/gateway/package.json mcps/gateway/
RUN npm ci --workspace mcps/gateway --include-workspace-root=false
COPY mcps/gateway/tsconfig.json mcps/gateway/tsconfig.build.json mcps/gateway/
COPY mcps/gateway/src mcps/gateway/src
RUN npm run build --workspace mcps/gateway \
  && npm prune --omit=dev --workspace mcps/gateway --include-workspace-root=false

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/mcps/gateway/package.json ./
COPY --from=build --chown=node:node /build/mcps/gateway/dist ./dist
COPY --chown=node:node mcps/gateway/routes.yaml ./routes.yaml
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
