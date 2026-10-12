# Troubleshooting

Start with the two places that explain most problems:

- **The task's output.** Click the failed task in Recent tasks. Build errors, compose
  errors and Docker's own messages are there in full.
- **Drydock's log.** `docker logs drydock`.

## Starting Drydock

### `set DRYDOCK_PASSWORD in .env`

Compose stops with this message when a required setting is missing. Copy `.env.example` to
`.env` and fill in `DRYDOCK_PASSWORD`, `DRYDOCK_PROJECTS_ROOT` and `DRYDOCK_DATA`.

### The port is already in use

Change `DRYDOCK_PORT` in `.env` and run `docker compose up -d` again.

### `permission denied` on the Docker socket

The container runs as root, so this means the socket is not at `/var/run/docker.sock`.
Rootless Docker and some desktop installations keep it elsewhere. Find it with
`docker context inspect` and change the left-hand side of the socket mount in
`docker-compose.yml`.

## Signing in

### "Cannot complete login due to an incorrect user name or password"

The credentials are the ones in `.env` **at the time the container was created**. See the
next entry if you have changed them since. Check which user name the running container
has with:

```bash
docker exec drydock printenv DRYDOCK_USER
```

### I changed the password in `.env` but the old one still works

Editing `.env` does not reach a running container: Drydock is handed its password when the
container is created and keeps that value until it is re-created. Restarting the container
is not enough either. Apply the change with:

```bash
docker compose up -d
```

Next time, use the bundled script, which updates `.env` and re-creates the container in one
step:

```bash
./set-password.sh
```

### Signed out unexpectedly

Sessions are held in memory, so restarting or upgrading Drydock signs everyone out. A
session also ends after 12 hours without activity.

## Metrics

### Charts say "Collecting data"

Samples are taken every 10 seconds and a rate needs two samples, so a new container shows
its first point after about 20 seconds. The week and month views fill in at one point every
ten minutes.

### The Trends page shows little

Container trends need a few minutes of history, the memory-growth check three hours, and
the storage forecast about six. Until then the page says so.

### Host figures look like the container's own

Host CPU, memory and network come from the host's `/proc`, mounted at `/host/proc`. If
that mount was removed from the compose file, Drydock falls back to its own view, where
network counters cover only its own interface. Restore the mount.

### A stopped container has no current figures

Docker reports statistics only for running containers. History up to the moment it
stopped remains on the Monitor tab.

## Console and logs

### The console says the session closed immediately

The image has no shell. Minimal images built from `scratch` or distroless bases contain
neither `bash` nor `sh`, so there is nothing to attach to. Use the Logs and Processes tabs
instead.

### The console does not connect behind a reverse proxy

The proxy must forward WebSocket upgrades and pass the `Host` header through unchanged.
See the nginx example in [Installation](installation.md#running-behind-a-reverse-proxy).

### The log tail is empty

The container writes nothing to standard output, or uses a logging driver that Docker
cannot read back (anything other than `json-file`, `local` or `journald`).

## Projects

### A project is not listed

Drydock lists directories under the projects root, at most two levels deep, that contain a
compose file or a `Dockerfile` with exactly those names. Hidden directories and folders
named `node_modules`, `venv`, `vendor`, `dist`, `build` or `snap` are skipped. Press
Refresh after adding one.

### Deploy fails with a missing variable

Compose reports `required variable … is missing a value` when the project expects a value
from its own `.env` file. Create that file in the project directory, as you would to deploy
from a shell.

### A deployed container sees an empty directory where its data should be

The compose file uses a relative bind mount and the project directory is not at the same
path inside the Drydock container as on the host. Check that `DRYDOCK_PROJECTS_ROOT` and
`DRYDOCK_DATA` are absolute host paths and that the compose file mounts each at the same
path on both sides. The background is in
[Architecture](architecture.md#same-path-mounts).

### A build cannot reach a private registry or repository

Builds run with the Drydock container's credentials, which are none by default. Sign in on
the host and mount the configuration into the container, for example by adding
`- /home/you/.docker/config.json:/root/.docker/config.json:ro` to the volumes in
`docker-compose.yml`.

## Import and export

### "a container named … already exists; choose another name"

Change the name in the import dialog, or delete or rename the existing container first.

### An imported container is created but does not start

Usually `port is already allocated`: another container publishes the same host port. The
task output says which. The container exists and is powered off; free the port and power
it on, or delete it and re-create it with a different mapping.

### "not enough free space on the datastore"

An upload needs a bit more than twice its size free in the data directory. Free space or
move `DRYDOCK_DATA` to a larger disk.

### "unrecognised archive"

Drydock accepts three kinds of file: a Drydock bundle, a `docker save` archive, and a
`.zip`, `.tar` or `.tar.gz` holding a compose file or Dockerfile at the top level or inside
one top-level folder. An archive with the project nested deeper is not recognised.

### Data is missing after an import

Bundles do not carry the contents of bind-mounted host directories, only their paths. Copy
that data to the same paths on the new host. The bundle's `manifest.json` lists them under
`binds`.

## Snapshots

### A reverted container went back to the old image

A container that belongs to a compose project is re-created from the project's own image
whenever the project is redeployed. Revert again afterwards, or build the change into the
project's image.

### Files in a volume did not revert

Snapshots cover the container's own filesystem. Volumes and bind mounts are left exactly as
they are. To capture volume data, use Export.

## Files under the data directory are owned by root

The container runs as root, so everything it writes is owned by root. Use `sudo` to manage
those files from the host, or delete exports and imported projects from the console.

## Reporting a problem

Open an issue with the Drydock version (Help › About), the Docker Engine version, what you
did, and the output of the failed task. Remove secrets from any compose files or logs you
attach.
