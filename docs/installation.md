# Installation

Drydock runs as a single container on the host it manages. This guide covers a first
install, the settings, upgrades, backups and removal.

## Requirements

- Linux with **Docker Engine 25 or newer** and the **Compose plugin** (`docker compose`). Drydock is
  developed and tested on Docker Engine 29.
- A user that can run `docker` commands.
- About 300 MB of disk for the image, plus space for metrics history (a few tens of MB) and
  for whatever you export.

Drydock is built on the official Docker CLI image and a Python standard-library server.
The build downloads the base image and three Alpine packages; nothing else is fetched.

## Install

1. Get the code.

   ```bash
   git clone https://github.com/grahamfairbank/drydock.git
   cd drydock
   ```

2. Create the settings file.

   ```bash
   cp .env.example .env
   ```

3. Edit `.env`.

   ```ini
   DRYDOCK_USER=admin
   DRYDOCK_PASSWORD=choose-a-strong-password
   DRYDOCK_PORT=9000
   DRYDOCK_PROJECTS_ROOT=/home/you
   DRYDOCK_DATA=/home/you/drydock/data
   ```

   - `DRYDOCK_PROJECTS_ROOT` is the directory Drydock scans for projects: folders that
     contain a compose file or a Dockerfile, up to two levels deep. Your home directory or
     a dedicated `/srv/projects` both work. It is mounted read-only.
   - `DRYDOCK_DATA` must be an **absolute path on the host**. The directory is created on
     first start. It may sit inside the projects root.

   Keep `.env` private: `chmod 600 .env`.

4. Build and start.

   ```bash
   docker compose up -d --build
   ```

5. Open `http://<host>:9000` and sign in.

Charts fill in as samples arrive: the first points appear after about 20 seconds, and the
Trends page becomes meaningful after a few hours.

## What the compose file mounts

| Mount | Access | Why |
|---|---|---|
| `/var/run/docker.sock` | read/write | Drydock manages the engine through its API. |
| `/proc` at `/host/proc` | read-only | Host CPU, memory, load and network counters. |
| `DRYDOCK_PROJECTS_ROOT` at the same path | read-only | Finding and deploying projects. |
| `DRYDOCK_DATA` at the same path | read/write | Metrics, exports, uploads, imported projects. |

The container restarts automatically with the host (`restart: unless-stopped`) and reports
its health on `/healthz`.

## Changing settings

Edit `.env`, then apply:

```bash
docker compose up -d
```

Changing the password this way signs everyone out.

## Running behind a reverse proxy

The built-in server speaks plain HTTP. To serve Drydock over HTTPS, put a reverse proxy in
front of it. The console and the live log tail need nothing special; the in-browser console
uses a WebSocket, which Caddy proxies automatically and nginx needs two extra headers for.

Caddy:

```caddyfile
drydock.example.com {
	reverse_proxy 127.0.0.1:9000
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:9000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    client_max_body_size 0;
}
```

Two details matter:

- **Pass the `Host` header through unchanged.** Drydock refuses a console connection whose
  `Origin` does not match `Host`.
- **Do not cap the upload size** if you plan to import bundles through the browser; they
  contain whole images.

To make Drydock reachable only through the proxy, publish the port on loopback by changing
the `ports` line in `docker-compose.yml` to `"127.0.0.1:${DRYDOCK_PORT:-9000}:9000"`.

## Upgrading

```bash
git pull
docker compose up -d --build
```

The data directory is kept, so history, exports and imported projects survive. You sign in
again afterwards because sessions are held in memory.

## Backing up

Everything Drydock owns is in `DRYDOCK_DATA`:

| Path | Contents |
|---|---|
| `drydock.db` | Metrics history, task log, events and container notes (SQLite). |
| `exports/` | Bundles you have exported. |
| `imports/` | Projects imported from archives or Git. |
| `uploads/`, `tmp/` | Transient files; safe to skip. |

Copy the directory while Drydock is stopped, or copy `exports/` and `imports/` at any time.
The files are owned by root because the container runs as root.

Drydock does not back up your containers on its own. To protect a workload, export it and
copy the bundle off the host.

## Uninstalling

```bash
docker compose down
docker image rm drydock:latest
```

Your containers, images and volumes are not affected. Remove the data directory if you no
longer want the history and exports:

```bash
sudo rm -rf /home/you/drydock/data
```

Snapshots are ordinary images named `drydock-snapshots/<container>:<timestamp>`; remove
them with `docker image rm` if you do not want to keep them.
