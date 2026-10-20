# Changelog

All notable changes to Drydock are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-10-20

First release.

### Inventory and control

- Host summary with CPU, memory and storage capacity meters, alarms, top consumers and
  inventory counts.
- Container inventory with live CPU and memory, sparklines, published ports as links,
  search, quick filters, multi-select and a right-click Actions menu.
- Power operations: power on, power off, restart, suspend, resume, kill.
- Live editing of autostart policy and CPU and memory limits; rename; delete; notes.
- Alarms for restart loops, failed health checks, non-zero exits, memory pressure, and low
  host disk or memory.

### Utilization and trends

- Metrics sampled every 10 seconds and kept for 30 days at three resolutions.
- Charts for CPU, memory, network and disk I/O per container, and for the host, over the
  last hour, 6 hours, day, week or month.
- A Trends page comparing each container's last hour with its last day, with memory-growth
  detection and a storage-full forecast.

### Working inside containers

- In-browser console attached to a shell in the container.
- Live log tail with follow, filter and download; process list.
- Snapshots of a container's filesystem, with revert.

### Import and export

- Projects: discover, register, rebuild and unregister compose and Dockerfile projects.
- Import of Drydock bundles, `docker save` archives, project archives and Git repositories.
- Export of containers to portable bundles holding configuration, image, named-volume data
  and a reference compose file that can also be restored without Drydock.

### Operations

- Storage (volumes, images, exports) and networking (networks, port map) views.
- Docker event history and a persistent task log.
- `set-password.sh` to change the console password and apply it in one step.
- Documentation: installation, user guide, import and export, API reference, architecture,
  security and troubleshooting.
