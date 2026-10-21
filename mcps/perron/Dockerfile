# Build context is the repository root: docker build -f mcps/perron/Dockerfile .
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY mcps/perron/package.json mcps/perron/
RUN npm ci --workspace mcps/perron --include-workspace-root=false
COPY mcps/perron/tsconfig.json mcps/perron/tsconfig.build.json mcps/perron/
COPY mcps/perron/src mcps/perron/src
RUN npm run build --workspace mcps/perron \
  && npm prune --omit=dev --workspace mcps/perron --include-workspace-root=false

FROM node:24.21.0-alpine3.24 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/mcps/perron/package.json ./
COPY --from=build --chown=node:node /build/mcps/perron/dist ./dist
COPY --chown=node:node mcps/perron/assets ./assets
# Timetable and geocode cache; mount a volume here to keep them across deploys.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.BASE_PATH||'')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
