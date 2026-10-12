# Import and export

Drydock moves workloads in and out of a host in four ways.

| You have | Use | Result |
|---|---|---|
| A directory on the host with a compose file or Dockerfile | [Register a project](#registering-a-project) | The project's containers, built and running |
| A container on this host you want to copy elsewhere | [Export](#exporting-a-container) | A portable bundle file |
| A bundle, an image archive or a zipped project | [Import an archive](#importing-an-archive) | Containers, an image, or an imported project |
| A Git repository | [Clone from Git](#cloning-from-git) | An imported project, optionally deployed |

## Registering a project

A **project** is a directory containing one of:

- a compose file: `compose.yaml`, `compose.yml`, `docker-compose.yml` or
  `docker-compose.yaml`;
- a `Dockerfile`.

Drydock scans the projects root up to two levels deep, so both `~/myapp/compose.yaml` and
`~/myapp/docker/compose.yaml` are found. Hidden directories and common dependency folders
(`node_modules`, `venv`, `vendor`, `dist`, `build`) are skipped. When a directory has both
a compose file and a Dockerfile, the compose file wins.

Open **Projects**, select one and choose **Register / Deploy**, or pick *Register an
existing project* in the Create wizard.

### Compose projects

Drydock runs `docker compose up -d --remove-orphans` in the project directory, with
`--build` unless you untick *Rebuild images before starting*. The project's own `.env` file
is honoured, exactly as when you run compose by hand.

Redeploying a registered project updates its containers in place, reusing the project name
they were created with. Containers started from a shell and containers started from Drydock
are the same containers; you can go back and forth freely.

### Dockerfile projects

Drydock builds the image as `<name>:latest`, then creates and starts a container from it.
You choose:

- the **container name** (defaults to the directory name);
- **port mappings**; left empty, the ports the image exposes are published on random host
  ports;
- **environment** variables.

The container gets the *start with host* autostart policy. Redeploying replaces it with a
container built from the current source.

### Unregistering

**Unregister** runs `docker compose down` for a compose project, or removes the container
for a Dockerfile project. The directory, the images and all volumes are kept.

## Exporting a container

Select one or more containers and choose **Actions › Export**.

| Option | Default | Effect |
|---|---|---|
| Include the data stored in named volumes | on | Each named volume's contents are added to the bundle. |
| Capture the current filesystem | off | Commits the container as it is now and exports that, instead of the image it was created from. Use it when files were changed inside the container. |
| Include the project source directory | off | Adds the compose project's directory (without `.git` and dependency folders). It may contain secrets such as `.env` files. |

The export runs as a task. When it completes, the bundle appears under **Storage ›
Exports**, where you can download it.

What a bundle does **not** contain:

- the contents of **bind-mounted host directories**. Their paths are recorded so the
  container can be re-created, but you copy the data yourself;
- secrets that live outside the container. Environment variables **are** included, since
  they are part of the container's configuration, so treat a bundle as sensitive.

Exporting several containers at once produces one bundle that restores them together,
which suits the services of one compose project.

## Importing an archive

Open the Create wizard and pick *Import a bundle, image or project archive*, or use
**Import** under Storage › Exports or Projects. Choose or drop a file; Drydock uploads it,
inspects it and shows the options that apply.

### A Drydock bundle

![Importing a bundle](media/import-bundle.png)

The dialog lists the containers in the bundle. For each you can change the **name on this
host**; a name that is already taken is pre-filled with an `-imported` suffix.

- **Power on after import** starts the containers once they are created.
- **Restore volume data** unpacks the saved volume contents. If a volume of the same name
  already exists, files in it are overwritten.

Drydock then loads the images, creates any missing networks, creates the containers with
their original configuration, restores the volume data and starts them.

Things to check on the new host:

- **Ports.** The container keeps its published ports. If one is taken, the container is
  created but fails to start; change the conflicting service or re-create the container
  with another port.
- **Bind mounts.** Paths are restored as recorded. Copy the data to the same paths first,
  or Docker creates empty directories there.
- **Networks.** Missing user-defined networks are created as plain bridge networks. Static
  addresses are dropped for networks Drydock had to create.

A bundle already in the Exports list can be deployed directly with **Deploy**, with no
upload.

### A Docker image archive

A file produced by `docker save` is loaded into the local image store. Create a container
from it afterwards with the wizard.

### A project archive

A `.zip`, `.tar` or `.tar.gz` that contains a compose file or Dockerfile, at the top level
or inside a single top-level folder. Drydock unpacks it into its imported-projects store
under the name you give, and builds and starts it if *Build and power on after import* is
ticked. It then appears in **Projects** with origin *Imported*.

### Size and space

Uploads are streamed to disk, so large bundles are fine. Drydock refuses an upload unless
the data directory has a bit more than twice the file's size free, since the archive is
unpacked while the upload still exists. Files that are uploaded but never imported are
removed after six hours.

## Cloning from Git

Pick *Clone a project from a Git repository* in the Create wizard and give an `https://`,
`ssh://` or `git@` URL. Drydock makes a shallow clone into the imported-projects store and,
if asked, deploys it.

Private repositories over SSH need a key inside the Drydock container, which the default
setup does not provide. For those, clone on the host into the projects root and register
the directory instead.

## The bundle format

A bundle is a gzip-compressed tar archive named `<container>-<timestamp>.drydock.tar.gz`.
It can be inspected and unpacked with ordinary tools.

```
manifest.json           what the bundle contains
containers/0.json       full `docker inspect` output for each container
compose.yml             a readable compose file describing the containers
images/0.tar            `docker save` archives, one per distinct image
volumes/0-0.tar         contents of each named volume
source/<project>/       the project directory, when requested
```

`manifest.json`:

```json
{
  "format": "drydock-bundle/1",
  "created": 1791827120.22,
  "drydock": "1.0.0",
  "host": "harbor-01",
  "source": null,
  "containers": [
    {
      "name": "demo-web",
      "image": "nginx:alpine",
      "original_image": "nginx:alpine",
      "image_file": "images/0.tar",
      "file": "containers/0.json",
      "running": true,
      "volumes": [
        { "name": "demo-content", "destination": "/usr/share/nginx/html", "file": "volumes/0-0.tar" }
      ],
      "networks": {},
      "binds": [],
      "ports": ["80/tcp"]
    }
  ]
}
```

Notes on the format:

- `image` is the reference the container is re-created from. With *Capture the current
  filesystem* it is a one-off `drydock-export/<name>:<timestamp>` image; `original_image`
  keeps the name the container was first created from.
- `compose.yml` is for reading and for restoring by hand without Drydock. Drydock itself
  re-creates containers from `containers/*.json`, which loses nothing.
- Volume archives are in the format of `docker cp`: a tar whose top-level entry is the
  mounted directory.

### Restoring a bundle without Drydock

```bash
mkdir bundle && tar -xzf demo-web-20261012-175000.drydock.tar.gz -C bundle
docker load -i bundle/images/0.tar
docker volume create demo-content
docker compose -f bundle/compose.yml up --no-start
docker cp - demo-web:/usr/share/nginx < bundle/volumes/0-0.tar
docker compose -f bundle/compose.yml start
```

The `docker cp` target is the **parent** of the volume's mount point, because the archive
contains the mounted directory itself.
