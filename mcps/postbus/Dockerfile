# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f mcps/postbus/Dockerfile .

# better-sqlite3 is native and is compiled against musl here, so the runtime
# stage reuses the same binary. Both stages use the same pinned image so the
# binary and the runtime musl always match.
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /build
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY mcps/postbus/package.json mcps/postbus/
RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspace mcps/postbus --include-workspace-root=false
COPY mcps/postbus/tsconfig.json mcps/postbus/tsconfig.build.json mcps/postbus/
COPY mcps/postbus/src mcps/postbus/src
RUN npm run build --workspace mcps/postbus \
  && npm prune --omit=dev --workspace mcps/postbus --include-workspace-root=false

FROM node:24.21.0-alpine3.24 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/postbus.db

# tini reaps zombies and forwards signals.
RUN apk add --no-cache tini \
    && mkdir -p /data \
    && chown -R node:node /data

COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/mcps/postbus/package.json ./
COPY --from=build --chown=node:node /build/mcps/postbus/dist ./dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
