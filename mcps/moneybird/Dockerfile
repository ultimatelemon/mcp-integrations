# Build context is the repository root: docker build -f mcps/moneybird/Dockerfile .
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY mcps/moneybird/package.json mcps/moneybird/
RUN npm ci --workspace mcps/moneybird --include-workspace-root=false
COPY mcps/moneybird/tsconfig.json mcps/moneybird/tsconfig.build.json mcps/moneybird/
COPY mcps/moneybird/src mcps/moneybird/src
RUN npm run build --workspace mcps/moneybird \
  && npm prune --omit=dev --workspace mcps/moneybird --include-workspace-root=false

FROM node:24.21.0-alpine3.24 AS runtime
WORKDIR /app
# stdio has no meaning in a container, so the image defaults to the HTTP transport.
ENV NODE_ENV=production \
    MONEYBIRD_TRANSPORT=http \
    MONEYBIRD_HOST=0.0.0.0 \
    PORT=3000
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/mcps/moneybird/package.json ./
COPY --from=build /build/mcps/moneybird/dist ./dist
COPY mcps/moneybird/spec/endpoints.json ./spec/endpoints.json
# Applied at startup by the oauth auth mode, so they ship with the image.
COPY mcps/moneybird/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["serve"]
