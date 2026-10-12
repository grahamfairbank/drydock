# API reference

The console is a client of a small HTTP API, and everything it does can be scripted. The
API is served on the same port as the console, under `/api`.

- [Conventions](#conventions)
- [Signing in](#signing-in)
- [Tasks](#tasks)
- [Overview and host](#overview-and-host)
- [Containers](#containers)
- [Metrics](#metrics)
- [Images, volumes, networks](#images-volumes-networks)
- [Export and import](#export-and-import)
- [Projects](#projects)
- [Streaming endpoints](#streaming-endpoints)

## Conventions

- Requests and responses are JSON unless noted.
- Every request other than `GET` must carry the header `X-Drydock: 1`. This is the API's
  cross-site request protection; requests without it are rejected with `403`.
- Every endpoint except `/api/login`, `/api/session` and `/healthz` needs a session cookie.
  Without one the answer is `401`.
- Errors are returned as `{"error": "message"}` with a 4xx or 5xx status.
- A container is addressed by **name or ID** wherever `{c}` appears.
- Timestamps are Unix seconds.

## Signing in

```bash
curl -c jar -H 'X-Drydock: 1' \
     -d '{"user":"admin","password":"your-password"}' \
     http://host:9000/api/login
```

The response sets the `drydock_session` cookie. Sessions last 12 hours from the last
request and are lost when Drydock restarts.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/login` | Body `{user, password}`. Sets the session cookie. |
| `GET` | `/api/session` | `{"user": "admin"}`, or `{"user": null}` when not signed in. |
| `POST` | `/api/logout` | Ends the session. |
| `GET` | `/healthz` | `{"ok": true}`. No authentication. |

The examples below assume the cookie jar from the login call:

```bash
alias dd='curl -s -b jar -H "X-Drydock: 1"'
```

## Tasks

Anything that changes state runs as a task and returns immediately:

```json
{"task": 1791827084}
```

Poll the task until its `state` is `success` or `error`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/tasks/{id}` | One task, including its output in `log` and its return value in `result`. |

```json
{
  "id": 1791827084, "name": "Create container", "target": "demo-web", "user": "admin",
  "queued": 1791827084.1, "started": 1791827084.1, "finished": 1791827085.3,
  "state": "success", "error": "", "progress": "", "log": "Creating container demo-web\nPowering on",
  "result": {"id": "832c17cf355b…", "name": "demo-web"}
}
```

`state` is one of `queued`, `running`, `success`, `error`. The latest tasks are also
included in `/api/overview`.

## Overview and host

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/overview` | Everything the console polls: host facts and current load, all containers with live stats, alarms, object counts and recent tasks. |
| `GET` | `/api/events?limit=200&name=` | Recorded Docker events, newest first. `name` restricts to one object. |
| `GET` | `/api/trends` | Last-hour versus last-day comparison per container, and the host storage forecast. |
| `GET` | `/api/storage` | Disk usage split into images, volumes, build cache and exports. |

A container entry in `/api/overview`:

```json
{
  "id": "832c17cf355b…", "name": "demo-web", "image": "nginx:alpine",
  "state": "running", "status": "Up 2 hours", "health": "", "exit_code": null,
  "project": "", "service": "", "network_mode": "bridge", "self": false,
  "ports": [{"host": 18080, "container": 80, "proto": "tcp"}],
  "stats": {"cpu": 0.21, "mem": 5033984, "mem_limit": 8225746944, "pids": 5,
            "rx": 1843.2, "tx": 3686.4, "br": 0, "bw": 0},
  "spark": [0.2, 0.2, 0.3]
}
```

`cpu` is a percentage of one core; `mem` and `mem_limit` are bytes; `rx`, `tx`, `br` and
`bw` are bytes per second for network and block I/O.

## Containers

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/api/containers/{c}` | | `docker inspect` output, live stats and the note. |
| `POST` | `/api/containers/{c}/start` | | Power on. *Task.* |
| `POST` | `/api/containers/{c}/stop` | | Power off, with a 10-second grace period. *Task.* |
| `POST` | `/api/containers/{c}/restart` | | Restart. *Task.* |
| `POST` | `/api/containers/{c}/pause` | | Suspend. *Task.* |
| `POST` | `/api/containers/{c}/unpause` | | Resume. *Task.* |
| `POST` | `/api/containers/{c}/kill` | | Kill. *Task.* |
| `DELETE` | `/api/containers/{c}?volumes=1` | | Delete, optionally with anonymous volumes. *Task.* |
| `POST` | `/api/containers/{c}/rename` | `{name}` | Rename. *Task.* |
| `POST` | `/api/containers/{c}/update` | `{restart, cpus, memory}` | Autostart policy, CPU limit in cores, memory limit in MB. Omitted fields are unchanged. *Task.* |
| `POST` | `/api/containers/{c}/note` | `{text}` | Save the note. |
| `GET` | `/api/containers/{c}/logs?tail=300` | | The last lines of output as `{"text": "…"}`. |
| `GET` | `/api/containers/{c}/top` | | Process list as `{Titles, Processes}`. |
| `GET` | `/api/containers/{c}/snapshots` | | Snapshots of this container. |
| `POST` | `/api/containers/{c}/snapshot` | `{name, comment}` | Take a snapshot. *Task.* |
| `POST` | `/api/containers/{c}/revert` | `{ref}` | Revert to the snapshot image `ref`. *Task.* |
| `POST` | `/api/create` | see below | Create a container from an image. *Task.* |

`restart` is one of `no`, `always`, `unless-stopped`, `on-failure`.

Creating a container:

```bash
dd http://host:9000/api/create -d '{
  "name": "blog",
  "image": "nginx:alpine",
  "ports": "8081:80",
  "volumes": "blog-content:/usr/share/nginx/html",
  "env": "TZ=UTC",
  "restart": "unless-stopped",
  "start": true
}'
```

`ports`, `volumes` and `env` are newline-separated strings in the formats the wizard
accepts. Optional fields: `cmd` (run through `/bin/sh -c`), `cpus`, `memory` (MB),
`network` (a network mode). The image is pulled when it is not present.

## Metrics

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/metrics?target={name}&range={r}` | Series for one container. |
| `GET` | `/api/metrics?target=_host&range={r}` | Series for the host. |
| `GET` | `/api/metrics?top={metric}&range={r}` | One metric for the six heaviest containers. |

`range` is `1h`, `6h`, `24h`, `7d` or `30d`. `metric` is `cpu`, `mem`, `rx`, `tx`, `br`,
`bw` or `pids`. Responses hold parallel arrays of at most about 360 points:

```json
{
  "from": 1791823500, "to": 1791827100, "step": 10,
  "t":   [1791826310, 1791826320, 1791826330],
  "cpu": [0.21, 0.19, 0.23],
  "mem": [5033984, 5033984, 5038080]
}
```

Container series carry `cpu`, `mem`, `mem_limit`, `rx`, `tx`, `br`, `bw`, `pids`. Host
series carry `cpu` (percentage of all cores), `mem`, `mem_total`, `disk`, `disk_total`,
`rx`, `tx`, `load1`, `running`.

## Images, volumes, networks

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/api/images` | | Images with tags, size and the containers using them. |
| `POST` | `/api/images/pull` | `{ref}` | Pull an image. *Task.* |
| `POST` | `/api/images/prune` | | Remove dangling images. *Task.* |
| `DELETE` | `/api/images/{sha256:id}?force=1` | | Delete an image. *Task.* |
| `GET` | `/api/volumes` | | Volumes with size and users. |
| `DELETE` | `/api/volumes/{name}` | | Delete a volume. *Task.* |
| `GET` | `/api/networks` | | Networks with subnets and attached containers. |
| `DELETE` | `/api/networks/{id}` | | Delete a network. *Task.* |

## Export and import

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/export` | `{ids, volumes, commit, source}` | Export containers to a bundle. *Task;* `result.file` is the bundle name. |
| `GET` | `/api/exports` | | Bundles in the exports store. |
| `GET` | `/api/exports/{file}` | | Download a bundle. |
| `DELETE` | `/api/exports/{file}` | | Delete a bundle. |
| `GET` | `/api/exports/{file}/deploy` | | Inspect a bundle: its manifest and name conflicts. |
| `POST` | `/api/exports/{file}/deploy` | import options | Import a stored bundle. *Task.* |
| `PUT` | `/api/upload?name={filename}` | raw file | Upload an archive. Returns what it is and an `upload` token. |
| `POST` | `/api/import` | `{upload, …options}` | Import an uploaded archive. *Task.* |
| `POST` | `/api/git` | `{url, name, deploy}` | Clone a repository into the imports store. *Task.* |

`ids` are full container IDs. Import options depend on what the archive is:

| Kind | Options |
|---|---|
| `bundle` | `names` (map of original to new name), `start`, `restore_volumes` |
| `image` | none |
| `project` | `name`, `deploy`, and for Dockerfile projects `ports` |

Moving a container between two hosts:

```bash
# on the source host
ID=$(docker inspect -f '{{.Id}}' demo-web)
dd http://src:9000/api/export -d "{\"ids\":[\"$ID\"],\"volumes\":true}"
dd http://src:9000/api/exports                       # find the file name
dd -o demo.drydock.tar.gz http://src:9000/api/exports/demo-web-20261012-175000.drydock.tar.gz

# on the destination host (with its own cookie jar)
dd -X PUT --data-binary @demo.drydock.tar.gz \
   "http://dst:9000/api/upload?name=demo.drydock.tar.gz"
# → {"kind": "bundle", "upload": "79fae32c-demo.drydock.tar.gz", …}
dd http://dst:9000/api/import -d '{"upload":"79fae32c-demo.drydock.tar.gz","start":true}'
```

## Projects

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/api/projects` | | Projects found on the host and imported, with their containers. |
| `GET` | `/api/projects/file?path=` | | The project's compose file or Dockerfile. |
| `POST` | `/api/projects/deploy` | `{path, build, name, ports, env}` | Register or redeploy. *Task.* |
| `POST` | `/api/projects/down` | `{path}` | Unregister. *Task.* |
| `POST` | `/api/projects/delete` | `{path}` | Delete an imported project's directory. |

`path` must be a project directory under the projects root or the imports store; anything
else is refused. `build` applies to compose projects; `name`, `ports` and `env` to
Dockerfile projects.

## Streaming endpoints

| Path | Protocol | Purpose |
|---|---|---|
| `GET /api/containers/{c}/logs/stream?tail=300` | Server-sent events | Live log tail. Each `data:` line is a JSON string holding a chunk of output. An `end` event marks the container stopping. |
| `GET /api/containers/{c}/console` | WebSocket | Interactive shell. |

On the console socket, binary frames in either direction carry terminal data. A text frame
from the client resizes the terminal:

```json
{"resize": [120, 40]}
```

The WebSocket handshake must carry the session cookie, and its `Origin` must match the
`Host` header.
