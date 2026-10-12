# Changelog

## 1.0.1 - 2026-10-12

- Added `set-password.sh`, which changes the console password and re-creates the container
  so the change takes effect. Editing `.env` alone never affected a running container; the
  documentation now says so plainly.
- CPU charts no longer repeat axis labels when usage is very low.
- The compose file inside a bundle now references the image the bundle actually contains.
- Screenshots retaken on a demonstration host.

## 1.0.0 - 2026-10-12

First release.

- Host summary with capacity meters, alarms, top consumers and inventory counts.
- Container inventory with live CPU and memory, sparklines, search, quick filters,
  multi-select and a right-click Actions menu.
- Power operations: power on, power off, restart, suspend, resume, kill.
- Metrics sampled every 10 seconds and kept for 30 days at three resolutions; charts for
  containers and the host; a Trends page with memory-growth detection and a storage
  forecast.
- In-browser console, live log tail with filter and download, process list.
- Snapshots of a container's filesystem, with revert.
- Projects: discover, register, rebuild and unregister compose and Dockerfile projects.
- Import of Drydock bundles, `docker save` archives, project archives and Git repositories.
- Export of containers to portable bundles with image, configuration and volume data.
- Live editing of autostart policy and CPU and memory limits; rename; delete; notes.
- Storage (volumes, images, exports) and networking (networks, port map) views.
- Docker event history and a persistent task log.
