# syntax=docker/dockerfile:1
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=8791
WORKDIR /app
RUN addgroup -S tapeapp && adduser -S tapeapp -G tapeapp && mkdir -p /data && chown tapeapp:tapeapp /data
COPY --from=build --chown=tapeapp:tapeapp /app/node_modules ./node_modules
COPY --from=build --chown=tapeapp:tapeapp /app/dist ./dist
COPY --chown=tapeapp:tapeapp package.json ./
USER tapeapp
VOLUME ["/data"]
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:8791/health || exit 1
# node:sqlite (hosted mode) is stable in practice but still flagged experimental in Node 22.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
