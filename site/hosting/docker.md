# Docker Compose

::: warning Status: unverified
The `Dockerfile` and `compose.yaml` follow the repository layout and the hub's documented behaviour, but **the maintainers have not run `docker compose up --build` end to end** yet, and no image is published. Treat this page as the intended setup and please report problems.
:::

```bash
git clone https://github.com/TinkerDoge/FoxFleet.git foxfleet && cd foxfleet
cp deploy/env.example .env      # then edit
docker compose up -d --build
docker compose logs foxfleet | grep "setup code"
```

## What the files do

**Dockerfile** (two stages, `node:22-alpine`): the first stage runs `npm ci && npm run build` in `web/` (the build also regenerates design tokens from `design/`); the second copies `server/`, `connector/`, `docs/CONNECT-AGENT.md` and the built `web/dist`, runs as the unprivileged `node` user, exposes `3080`, stores data in `/data` and has a `HEALTHCHECK` on `/health`. The image sets `FOXFLEET_HOST=0.0.0.0`, so the hub prints a **setup code** on first start.

**compose.yaml** publishes the port only on loopback and keeps data in a named volume:

```yaml
services:
  foxfleet:
    build: .
    ports: ["127.0.0.1:3080:3080"]     # publish through a proxy or tunnel, not directly
    environment:
      FOXFLEET_TRUSTED_ORIGINS: ${FOXFLEET_TRUSTED_ORIGINS:-http://localhost:3080,http://127.0.0.1:3080}
      FOXFLEET_PASSWORD: ${FOXFLEET_PASSWORD:-}
    volumes: [foxfleet-data:/data]
    restart: unless-stopped
volumes:
  foxfleet-data:
```

Set `FOXFLEET_TRUSTED_ORIGINS` in `.env` to your public https origin once a proxy or tunnel is in front. Do **not** change the port mapping to `0.0.0.0` unless the host firewall blocks it.

## Operating it

```bash
docker compose logs -f foxfleet
docker compose pull && docker compose up -d --build     # after git pull
docker run --rm -v foxfleet_foxfleet-data:/data -v "$PWD":/out alpine \
  tar czf /out/foxfleet-data-$(date +%F).tgz -C /data .   # backup (volume name = <project>_foxfleet-data)
```

See [Backups and restore](./backups).
