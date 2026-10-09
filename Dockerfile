# syntax=docker/dockerfile:1
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY design /src/design
COPY web ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY connector ./connector
COPY docs/CONNECT-AGENT.md ./docs/CONNECT-AGENT.md
COPY --from=web /src/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
ENV PORT=3080 FOXFLEET_HOST=0.0.0.0 FOXFLEET_CONFIG=/data/config.json
USER node
VOLUME ["/data"]
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
