"""Operations: container lifecycle, snapshots, bundles (export/import), projects."""
import io
import json
import os
import re
import shutil
import socket
import subprocess
import tarfile
import time
import zipfile

from . import dockerapi as d
from . import store

VERSION = "1.0.0"
DATA = store.DATA
ROOT = os.path.realpath(store.ROOT)
EXPORTS = os.path.join(DATA, "exports")
IMPORTS = os.path.join(DATA, "imports")
UPLOADS = os.path.join(DATA, "uploads")
TMP = os.path.join(DATA, "tmp")
COMPOSE_NAMES = ("compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml")
BUNDLE_FORMAT = "drydock-bundle/1"
SNAP_REPO = "drydock-snapshots"
SKIP_DIRS = {"node_modules", "snap", "__pycache__", "venv", "vendor", "dist", "build"}
NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


def init():
    for p in (EXPORTS, IMPORTS, UPLOADS, TMP):
        os.makedirs(p, exist_ok=True)
    for f in os.listdir(TMP):
        shutil.rmtree(os.path.join(TMP, f), ignore_errors=True)


def self_id():
    """Id prefix of the container Drydock itself runs in (its hostname)."""
    return socket.gethostname() if os.path.exists("/.dockerenv") else ""


def cname(insp):
    return insp["Name"].lstrip("/")


def check_name(name):
    if not NAME_RE.match(name or ""):
        raise ValueError(f"invalid container name: {name!r}")
    return name


def exists(name):
    try:
        d.get(f"/containers/{name}/json")
        return True
    except d.DockerError:
        return False


def guard_self(insp, what):
    me = self_id()
    if me and insp["Id"].startswith(me):
        raise ValueError(f"Drydock cannot {what} its own container")


# ---------------------------------------------------------------- lifecycle
def power(cid, action):
    insp = d.get(f"/containers/{cid}/json")
    if action in ("stop", "kill", "pause"):
        guard_self(insp, action)
    query = {"t": 10} if action in ("stop", "restart") else None
    d.post(f"/containers/{cid}/{action}", query, timeout=90)


def remove(cid, volumes=False):
    insp = d.get(f"/containers/{cid}/json")
    guard_self(insp, "delete")
    d.delete(f"/containers/{cid}", {"force": True, "v": volumes})


def update(cid, restart=None, memory_mb=None, cpus=None):
    body = {}
    if restart:
        body["RestartPolicy"] = {"Name": restart}
    if memory_mb:
        body["Memory"] = int(float(memory_mb) * 1048576)
        body["MemorySwap"] = body["Memory"] * 2
    if cpus:
        body["NanoCpus"] = int(float(cpus) * 1e9)
    if body:
        d.post(f"/containers/{cid}/update", body=body)


def create_from_inspect(insp, image=None, name=None, fresh_networks=()):
    """Re-create a container from an inspect document."""
    cfg = dict(insp["Config"])
    host = dict(insp["HostConfig"])
    mode = host.get("NetworkMode", "")
    if image:
        cfg["Image"] = image
    if cfg.get("Hostname") == insp.get("Id", "")[:12] or mode.startswith("container:"):
        cfg.pop("Hostname", None)
    cfg.pop("MacAddress", None)
    endpoints = {}
    if not mode.startswith(("host", "none", "container:")):
        short = insp.get("Id", "")[:12]
        for net, ep in (insp.get("NetworkSettings", {}).get("Networks") or {}).items():
            e = {}
            aliases = [a for a in (ep.get("Aliases") or []) if a != short]
            if aliases and net != "bridge":
                e["Aliases"] = aliases
            if ep.get("IPAMConfig") and net not in fresh_networks:
                e["IPAMConfig"] = ep["IPAMConfig"]
            endpoints[net] = e
    body = dict(cfg)
    body["HostConfig"] = host
    if endpoints:
        body["NetworkingConfig"] = {"EndpointsConfig": endpoints}
    res = d.post("/containers/create", {"name": name or cname(insp)}, body=body)
    return res["Id"]


def parse_ports(lines):
    exposed, bindings = {}, {}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        spec, _, proto = line.partition("/")
        proto = proto or "tcp"
        parts = spec.split(":")
        if len(parts) == 1:
            ip, hostp, cont = "", "", parts[0]
        elif len(parts) == 2:
            ip, hostp, cont = "", parts[0], parts[1]
        else:
            ip, hostp, cont = parts[0], parts[1], parts[2]
        if not cont.isdigit() or (hostp and not hostp.isdigit()):
            raise ValueError(f"bad port mapping: {line}")
        key = f"{cont}/{proto}"
        exposed[key] = {}
        bindings.setdefault(key, []).append({"HostIp": ip, "HostPort": hostp})
    return exposed, bindings


def pull(task, ref):
    repo, tag = ref, "latest"
    last = ref.rsplit("/", 1)[-1]
    if "@" in ref:
        repo, tag = ref.split("@", 1)
    elif ":" in last:
        repo, tag = ref.rsplit(":", 1)
    task.step(f"Pulling {repo}:{tag}")
    resp = d.request("POST", "/images/create", {"fromImage": repo, "tag": tag},
                     timeout=600, stream=True)
    seen = {}
    try:
        for line in resp:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("error"):
                raise d.DockerError(500, ev["error"])
            status = ev.get("status", "")
            key = ev.get("id", "")
            if seen.get(key) != status:
                seen[key] = status
                task.log(f"{key}: {status}" if key else status)
    finally:
        d.close_stream(resp)


def create(task, spec):
    name = check_name(spec.get("name", "").strip())
    image = spec.get("image", "").strip()
    if not image:
        raise ValueError("an image is required")
    try:
        d.get(f"/images/{image}/json")
    except d.DockerError:
        pull(task, image)
    exposed, bindings = parse_ports(spec.get("ports", "").splitlines())
    host = {"PortBindings": bindings,
            "RestartPolicy": {"Name": spec.get("restart") or "no"},
            "Binds": [v.strip() for v in spec.get("volumes", "").splitlines() if v.strip()]}
    if spec.get("memory"):
        host["Memory"] = int(float(spec["memory"]) * 1048576)
    if spec.get("cpus"):
        host["NanoCpus"] = int(float(spec["cpus"]) * 1e9)
    if spec.get("network"):
        host["NetworkMode"] = spec["network"]
    body = {"Image": image, "ExposedPorts": exposed, "HostConfig": host,
            "Env": [e.strip() for e in spec.get("env", "").splitlines() if e.strip()],
            "Labels": {"drydock.created": "true"}}
    if spec.get("cmd", "").strip():
        body["Cmd"] = ["/bin/sh", "-c", spec["cmd"].strip()]
    task.step(f"Creating container {name}")
    cid = d.post("/containers/create", {"name": name}, body=body)["Id"]
    if spec.get("start", True):
        task.step("Powering on")
        d.post(f"/containers/{cid}/start")
    return {"id": cid, "name": name}


# ---------------------------------------------------------------- snapshots
def snapshots(name):
    imgs = d.get("/images/json", {"filters": {"label": [f"drydock.snapshot.of={name}"]}}) or []
    out = []
    for i in imgs:
        labels = i.get("Labels") or {}
        out.append({"id": i["Id"], "ref": (i.get("RepoTags") or [i["Id"]])[0],
                    "name": labels.get("drydock.snapshot.name", ""),
                    "comment": labels.get("drydock.snapshot.comment", ""),
                    "created": i["Created"], "size": i["Size"]})
    return sorted(out, key=lambda s: -s["created"])


def snapshot(task, cid, label, comment):
    insp = d.get(f"/containers/{cid}/json")
    name = cname(insp)
    tag = time.strftime("%Y%m%d-%H%M%S")
    repo = f"{SNAP_REPO}/{name.lower()}"
    task.step(f"Committing filesystem of {name}")
    labels = dict(insp["Config"].get("Labels") or {})
    labels.update({"drydock.snapshot.of": name, "drydock.snapshot.name": label or tag,
                   "drydock.snapshot.comment": comment or ""})
    d.post("/commit", {"container": insp["Id"], "repo": repo, "tag": tag, "pause": True},
           body={"Labels": labels}, timeout=600)
    return {"ref": f"{repo}:{tag}"}


def revert(task, cid, ref):
    insp = d.get(f"/containers/{cid}/json")
    guard_self(insp, "revert")
    name = cname(insp)
    running = insp["State"]["Running"]
    old = f"{name}-drydock-old"
    if running:
        task.step(f"Stopping {name}")
        d.post(f"/containers/{insp['Id']}/stop", {"t": 10}, timeout=90)
    d.post(f"/containers/{insp['Id']}/rename", {"name": old})
    new_id = None
    try:
        task.step(f"Re-creating {name} from {ref}")
        new_id = create_from_inspect(insp, image=ref, name=name)
        if running:
            d.post(f"/containers/{new_id}/start")
    except Exception:
        task.log("Revert failed, restoring the previous container")
        if new_id:
            d.delete(f"/containers/{new_id}", {"force": True})
        d.post(f"/containers/{insp['Id']}/rename", {"name": name})
        if running:
            d.post(f"/containers/{insp['Id']}/start")
        raise
    d.delete(f"/containers/{insp['Id']}", {"force": True})
    return {"id": new_id}


# ---------------------------------------------------------------- export
def _spool(resp, path, task, what):
    total = 0
    mark = time.time()
    try:
        with open(path, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
                if time.time() - mark > 2:
                    mark = time.time()
                    task.progress = f"{what}: {total / 1048576:.0f} MB"
    finally:
        d.close_stream(resp)
    task.log(f"{what}: {total / 1048576:.1f} MB")
    return total


def _add_bytes(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = int(time.time())
    tar.addfile(info, io.BytesIO(data))


def compose_yaml(insps, images=None):
    """A readable compose file describing the containers (for reference)."""
    def q(s):
        return json.dumps(str(s))
    out = ["# Generated by Drydock from the running configuration.", "services:"]
    volumes, networks = set(), set()
    for n, insp in enumerate(insps):
        cfg, host = insp["Config"], insp["HostConfig"]
        out.append(f"  {cname(insp)}:")
        out.append(f"    image: {q(images[n] if images else cfg['Image'])}")
        out.append(f"    container_name: {q(cname(insp))}")
        policy = (host.get("RestartPolicy") or {}).get("Name")
        if policy and policy != "no":
            out.append(f"    restart: {policy}")
        mode = host.get("NetworkMode", "")
        if mode in ("host", "none"):
            out.append(f"    network_mode: {mode}")
        if cfg.get("Entrypoint"):
            out.append(f"    entrypoint: {json.dumps(cfg['Entrypoint'])}")
        if cfg.get("Cmd"):
            out.append(f"    command: {json.dumps(cfg['Cmd'])}")
        ports = []
        for port, binds in (host.get("PortBindings") or {}).items():
            for b in binds or []:
                ip = b.get("HostIp")
                prefix = f"{ip}:" if ip and ip not in ("0.0.0.0", "::") else ""
                ports.append(f"{prefix}{b.get('HostPort', '')}:{port}")
        if ports:
            out.append("    ports:")
            out += [f"      - {q(p)}" for p in ports]
        if cfg.get("Env"):
            out.append("    environment:")
            out += [f"      - {q(e)}" for e in cfg["Env"]]
        mounts = []
        for m in insp.get("Mounts") or []:
            src = m.get("Name") if m.get("Type") == "volume" else m.get("Source")
            if m.get("Type") == "volume":
                volumes.add(src)
            mounts.append(f"{src}:{m['Destination']}" + ("" if m.get("RW", True) else ":ro"))
        if mounts:
            out.append("    volumes:")
            out += [f"      - {q(m)}" for m in mounts]
        nets = [n for n in (insp.get("NetworkSettings", {}).get("Networks") or {})
                if n not in ("bridge", "host", "none")]
        if nets and mode not in ("host", "none"):
            networks.update(nets)
            out.append("    networks:")
            out += [f"      - {q(n)}" for n in nets]
        if host.get("Memory"):
            out.append(f"    mem_limit: {host['Memory']}")
        if host.get("NanoCpus"):
            out.append(f"    cpus: {host['NanoCpus'] / 1e9}")
    for title, items in (("volumes", volumes), ("networks", networks)):
        if items:
            out.append(f"{title}:")
            for v in sorted(items):
                out += [f"  {q(v)}:", "    external: true"]
    return "\n".join(out) + "\n"


def _source_filter(info):
    parts = info.name.split("/")
    if any(p in (".git", "node_modules", "__pycache__") for p in parts):
        return None
    return info


def export(task, ids, commit=False, volumes=True, source=False):
    """Write a portable bundle (config + images + volume data) to the exports store."""
    insps = [d.get(f"/containers/{i}/json") for i in ids]
    if not insps:
        raise ValueError("nothing to export")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    base = cname(insps[0]) if len(insps) == 1 else f"{cname(insps[0])}+{len(insps) - 1}"
    fname = f"{base}-{stamp}.drydock.tar.gz"
    work = os.path.join(TMP, f"export-{task.id}")
    os.makedirs(work, exist_ok=True)
    temp_images = []
    manifest = {"format": BUNDLE_FORMAT, "created": time.time(), "drydock": VERSION,
                "host": (d.get("/info") or {}).get("Name", ""), "containers": [], "source": None}
    try:
        image_files = {}
        for n, insp in enumerate(insps):
            name = cname(insp)
            ref = insp["Config"]["Image"]
            try:
                if d.get(f"/images/{ref}/json")["Id"] != insp["Image"]:
                    ref = insp["Image"]
            except d.DockerError:
                ref = insp["Image"]
            if commit:
                task.step(f"Committing current filesystem of {name}")
                repo = f"drydock-export/{name.lower()}"
                d.post("/commit", {"container": insp["Id"], "repo": repo, "tag": stamp,
                                   "pause": True}, body={}, timeout=600)
                ref = f"{repo}:{stamp}"
                temp_images.append(ref)
            image_files.setdefault(ref, f"images/{len(image_files)}.tar")
            vols = []
            if volumes:
                for i, m in enumerate(insp.get("Mounts") or []):
                    if m.get("Type") == "volume":
                        vols.append({"name": m.get("Name"), "destination": m["Destination"],
                                     "file": f"volumes/{n}-{i}.tar"})
            nets = {}
            for net in (insp.get("NetworkSettings", {}).get("Networks") or {}):
                if net not in ("bridge", "host", "none"):
                    try:
                        nets[net] = d.get(f"/networks/{net}").get("Driver", "bridge")
                    except d.DockerError:
                        nets[net] = "bridge"
            manifest["containers"].append({
                "name": name, "image": ref, "image_file": image_files[ref],
                "original_image": insp["Config"]["Image"], "file": f"containers/{n}.json",
                "running": insp["State"]["Running"], "volumes": vols, "networks": nets,
                "binds": [m["Source"] for m in insp.get("Mounts") or [] if m.get("Type") == "bind"],
                "ports": sorted((insp["HostConfig"].get("PortBindings") or {}).keys())})
        src_dir = ""
        if source:
            src_dir = (insps[0]["Config"].get("Labels") or {}).get(
                "com.docker.compose.project.working_dir", "")
            if src_dir and os.path.isdir(src_dir):
                manifest["source"] = os.path.basename(src_dir)
            else:
                src_dir = ""
                task.log("No project directory found for this container; source not included")

        tmp_out = os.path.join(work, fname)
        with tarfile.open(tmp_out, "w:gz", compresslevel=3) as tar:
            _add_bytes(tar, "manifest.json", json.dumps(manifest, indent=2).encode())
            for n, insp in enumerate(insps):
                _add_bytes(tar, f"containers/{n}.json", json.dumps(insp, indent=1).encode())
            _add_bytes(tar, "compose.yml", compose_yaml(
                insps, [c["image"] for c in manifest["containers"]]).encode())
            for ref, arc in image_files.items():
                task.step(f"Saving image {ref}")
                spool = os.path.join(work, "image.tar")
                resp = d.request("GET", f"/images/{ref}/get", timeout=600, stream=True)
                _spool(resp, spool, task, "Image")
                task.progress = f"Compressing image {ref}"
                tar.add(spool, arcname=arc)
                os.remove(spool)
            for entry, insp in zip(manifest["containers"], insps):
                for v in entry["volumes"]:
                    task.step(f"Saving volume {v['name']} ({v['destination']})")
                    spool = os.path.join(work, "volume.tar")
                    resp = d.request("GET", f"/containers/{insp['Id']}/archive",
                                     {"path": v["destination"]}, timeout=600, stream=True)
                    _spool(resp, spool, task, "Volume")
                    tar.add(spool, arcname=v["file"])
                    os.remove(spool)
            if src_dir:
                task.step(f"Adding project source {src_dir}")
                tar.add(src_dir, arcname="source/" + os.path.basename(src_dir), filter=_source_filter)
        os.replace(tmp_out, os.path.join(EXPORTS, fname))
        size = os.path.getsize(os.path.join(EXPORTS, fname))
        task.log(f"Bundle written: {fname} ({size / 1048576:.1f} MB)")
        return {"file": fname, "size": size}
    finally:
        for ref in temp_images:
            try:
                d.delete(f"/images/{ref}")
            except d.DockerError:
                pass
        shutil.rmtree(work, ignore_errors=True)


_manifest_cache = {}


def read_manifest(path):
    key = (path, os.path.getmtime(path), os.path.getsize(path))
    if key in _manifest_cache:
        return _manifest_cache[key]
    manifest = None
    try:
        with tarfile.open(path, "r:*") as tar:
            first = tar.next()
            if first and first.name == "manifest.json" and first.size < 4 << 20:
                doc = json.load(tar.extractfile(first))
                if isinstance(doc, dict) and doc.get("format") == BUNDLE_FORMAT:
                    manifest = doc
    except (tarfile.TarError, OSError, ValueError, EOFError):
        manifest = None
    _manifest_cache[key] = manifest
    return manifest


def list_exports():
    out = []
    for f in sorted(os.listdir(EXPORTS)):
        p = os.path.join(EXPORTS, f)
        if not os.path.isfile(p):
            continue
        m = read_manifest(p)
        out.append({"file": f, "size": os.path.getsize(p), "mtime": os.path.getmtime(p),
                    "host": (m or {}).get("host", ""),
                    "containers": [{"name": c["name"], "image": c["original_image"],
                                    "volumes": len(c["volumes"])}
                                   for c in (m or {}).get("containers", [])]})
    return sorted(out, key=lambda e: -e["mtime"])


def safe_file(folder, name):
    name = os.path.basename(name or "")
    path = os.path.join(folder, name)
    if not name or name.startswith(".") or not os.path.isfile(path):
        raise FileNotFoundError(name)
    return path


# ---------------------------------------------------------------- import
def classify(path):
    """Work out what an uploaded archive is: bundle, image, project or unknown."""
    m = read_manifest(path)
    if m:
        taken = []
        for c in m["containers"]:
            c["exists"] = exists(c["name"])
            if c["exists"]:
                taken.append(c["name"])
        return {"kind": "bundle", "manifest": m, "conflicts": taken}
    names = []
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as z:
                names = z.namelist()[:20000]
        else:
            with tarfile.open(path, "r:*") as tar:
                for i, member in enumerate(tar):
                    names.append(member.name)
                    if i > 20000:
                        break
    except (tarfile.TarError, OSError, EOFError, zipfile.BadZipFile):
        return {"kind": "unknown"}
    clean = [n.lstrip("./") for n in names]
    top = set(clean)
    if "oci-layout" in top or ("manifest.json" in top and ("repositories" in top or "index.json" in top)):
        return {"kind": "image"}
    for n in clean:
        parts = n.rstrip("/").split("/")
        if len(parts) <= 2 and (parts[-1] in COMPOSE_NAMES or parts[-1] == "Dockerfile"):
            return {"kind": "project", "entry": n, "files": len(clean)}
    return {"kind": "unknown"}


def load_image(task, fileobj, size=None):
    headers = {"Content-Length": str(size)} if size is not None else {}
    resp = d.request("POST", "/images/load", {"quiet": True}, raw=fileobj, headers=headers,
                     timeout=1800, stream=True)
    try:
        for line in resp:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("error"):
                raise d.DockerError(500, ev["error"])
            if ev.get("stream"):
                task.log(ev["stream"].strip())
    finally:
        d.close_stream(resp)


def import_image(task, path):
    task.step("Loading image into Docker")
    with open(path, "rb") as f:
        load_image(task, f, os.path.getsize(path))


def import_bundle(task, path, names=None, start=True, restore_volumes=True):
    """Re-create the containers of a bundle. names maps original -> new name."""
    names = names or {}
    manifest = read_manifest(path)
    if not manifest:
        raise ValueError("not a Drydock bundle")
    entries = manifest["containers"]
    for e in entries:
        e["target"] = check_name(names.get(e["name"]) or e["name"])
        if exists(e["target"]):
            raise ValueError(f"a container named {e['target']} already exists; choose another name")
    insps, created = {}, {}
    vol_index = {v["file"]: (e, v) for e in entries for v in e["volumes"]}

    def create_all():
        if created or len(insps) < len(entries):
            return
        have = {n["Name"] for n in d.get("/networks") or []}
        for e in entries:
            fresh = []
            for net, driver in e["networks"].items():
                if net not in have:
                    task.step(f"Creating network {net}")
                    d.post("/networks/create", body={
                        "Name": net, "Driver": driver if driver in ("bridge", "macvlan", "ipvlan") else "bridge"})
                    have.add(net)
                    fresh.append(net)
            for b in e["binds"]:
                if not os.path.exists(b) and b.startswith(ROOT):
                    task.log(f"Note: bind mount source {b} does not exist on this host")
            task.step(f"Creating container {e['target']}")
            created[e["name"]] = create_from_inspect(
                insps[e["file"]], image=e["image"], name=e["target"], fresh_networks=fresh)

    try:
        with tarfile.open(path, "r:*") as tar:
            for member in tar:
                if member.name.startswith("containers/") and member.isfile():
                    insps[member.name] = json.load(tar.extractfile(member))
                elif member.name.startswith("images/") and member.isfile():
                    task.step(f"Loading {member.name} ({member.size / 1048576:.0f} MB)")
                    load_image(task, tar.extractfile(member), member.size)
                elif member.name in vol_index and member.isfile():
                    create_all()
                    e, v = vol_index[member.name]
                    if restore_volumes:
                        task.step(f"Restoring volume data for {e['target']}:{v['destination']}")
                        parent = os.path.dirname(v["destination"].rstrip("/")) or "/"
                        d.request("PUT", f"/containers/{created[e['name']]}/archive",
                                  {"path": parent}, raw=tar.extractfile(member),
                                  headers={"Content-Length": str(member.size)}, timeout=1800)
                elif member.name.startswith("source/") and manifest.get("source"):
                    rel = member.name[len("source/"):]
                    member.name = rel
                    tar.extract(member, IMPORTS, filter="data")
        create_all()
        if len(created) < len(entries):
            raise ValueError("bundle is incomplete")
        if start:
            for e in entries:
                task.step(f"Powering on {e['target']}")
                d.post(f"/containers/{created[e['name']]}/start")
    except Exception:
        if not start or len(created) < len(entries):
            for cid in created.values():
                try:
                    d.delete(f"/containers/{cid}", {"force": True})
                except d.DockerError:
                    pass
        raise
    return {"containers": [e["target"] for e in entries]}


def import_project(task, path, name):
    """Unpack a project archive into the imports store."""
    name = check_name(name)
    dest = os.path.join(IMPORTS, name)
    if os.path.exists(dest):
        raise ValueError(f"an imported project named {name} already exists")
    stage = os.path.join(TMP, f"import-{task.id}")
    os.makedirs(stage)
    try:
        task.step("Unpacking archive")
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as z:
                z.extractall(stage)
        else:
            with tarfile.open(path, "r:*") as tar:
                tar.extractall(stage, filter="data")
        items = os.listdir(stage)
        root = stage
        if len(items) == 1 and os.path.isdir(os.path.join(stage, items[0])):
            root = os.path.join(stage, items[0])
        shutil.move(root, dest)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    task.log(f"Project unpacked to {dest}")
    return {"path": dest}


def git_clone(task, url, name):
    if not re.match(r"^(https?://|git@|ssh://)[\w.@:/~+-]+$", url or ""):
        raise ValueError("unsupported repository URL")
    name = check_name(name or re.sub(r"\.git$", "", url.rstrip("/").rsplit("/", 1)[-1]))
    dest = os.path.join(IMPORTS, name)
    if os.path.exists(dest):
        raise ValueError(f"an imported project named {name} already exists")
    task.step(f"Cloning {url}")
    run_cmd(task, ["git", "clone", "--depth", "1", "--", url, dest])
    return {"path": dest}


# ---------------------------------------------------------------- projects
def run_cmd(task, argv, cwd=None):
    task.log("$ " + " ".join(argv))
    env = dict(os.environ, DOCKER_CLI_HINTS="false", BUILDKIT_PROGRESS="plain",
               GIT_TERMINAL_PROMPT="0", COMPOSE_MENU="false")
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, errors="replace")
    for line in proc.stdout:
        task.log(line)
        task.progress = line.strip()[:120]
    if proc.wait() != 0:
        raise RuntimeError(f"{argv[0]} exited with status {proc.returncode}")


def _project_kind(path):
    try:
        names = set(os.listdir(path))
    except OSError:
        return None, None
    for n in COMPOSE_NAMES:
        if n in names:
            return "compose", n
    if "Dockerfile" in names:
        return "dockerfile", "Dockerfile"
    return None, None


def _scan(root, depth):
    found = []
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name.lower())
    except OSError:
        return found
    for e in entries:
        if e.name.startswith(".") or e.name in SKIP_DIRS or not e.is_dir(follow_symlinks=False):
            continue
        if os.path.realpath(e.path) == os.path.realpath(DATA):
            continue
        kind, entry = _project_kind(e.path)
        if kind:
            found.append((e.path, kind, entry))
        elif depth > 1:
            found += _scan(e.path, depth - 1)
    return found


def allowed_project(path):
    real = os.path.realpath(path)
    for base in (ROOT, os.path.realpath(IMPORTS)):
        if real == base or real.startswith(base + os.sep):
            kind, entry = _project_kind(real)
            if kind:
                return real, kind, entry
    raise ValueError("not a project directory Drydock can see")


def list_projects(containers):
    by_dir = {}
    for c in containers:
        labels = c.get("Labels") or {}
        wd = labels.get("com.docker.compose.project.working_dir") or labels.get("drydock.project.dir")
        if wd:
            by_dir.setdefault(os.path.realpath(wd), []).append(c)
    me = self_id()
    out = []
    seen = set()
    for base, origin in ((ROOT, "host"), (IMPORTS, "imported")):
        for path, kind, entry in _scan(base, 2):
            real = os.path.realpath(path)
            if real in seen:
                continue
            seen.add(real)
            cs = by_dir.get(real, [])
            out.append({
                "path": real, "name": os.path.basename(real), "kind": kind, "entry": entry,
                "origin": origin, "self": any(me and c["Id"].startswith(me) for c in cs),
                "containers": [{"id": c["Id"], "name": c["Names"][0].lstrip("/"),
                                "state": c["State"]} for c in cs],
                "mtime": os.path.getmtime(os.path.join(real, entry))})
    return out


def project_file(path):
    real, _, entry = allowed_project(path)
    with open(os.path.join(real, entry), errors="replace") as f:
        return {"file": entry, "text": f.read(200000)}


def _compose_base(real, entry):
    """Compose command line reusing the project name of containers already deployed."""
    argv = ["docker", "compose", "--ansi", "never", "-f", os.path.join(real, entry)]
    for c in d.get("/containers/json", {"all": True}) or []:
        labels = c.get("Labels") or {}
        if os.path.realpath(labels.get("com.docker.compose.project.working_dir", "/nonexistent")) == real:
            argv += ["-p", labels.get("com.docker.compose.project", os.path.basename(real))]
            break
    return argv


def deploy_project(task, path, spec=None):
    """Register a project directory as containers (compose up, or build + run)."""
    spec = spec or {}
    real, kind, entry = allowed_project(path)
    if kind == "compose":
        task.step(f"Deploying compose project {real}")
        argv = _compose_base(real, entry) + ["up", "-d", "--remove-orphans"]
        if spec.get("build", True):
            argv.append("--build")
        run_cmd(task, argv, cwd=real)
        return {"path": real}
    name = check_name(spec.get("name") or re.sub(r"[^a-z0-9_.-]", "-", os.path.basename(real).lower()))
    image = f"{name}:latest"
    task.step(f"Building image {image}")
    run_cmd(task, ["docker", "build", "-t", image, real], cwd=real)
    if exists(name):
        task.step(f"Replacing existing container {name}")
        remove(name)
    exposed, bindings = parse_ports((spec.get("ports") or "").splitlines())
    if not bindings:
        for port in (d.get(f"/images/{image}/json").get("Config", {}).get("ExposedPorts") or {}):
            exposed[port] = {}
            bindings[port] = [{"HostIp": "", "HostPort": ""}]
    body = {"Image": image, "ExposedPorts": exposed,
            "Env": [e.strip() for e in (spec.get("env") or "").splitlines() if e.strip()],
            "Labels": {"drydock.project.dir": real},
            "HostConfig": {"PortBindings": bindings,
                           "RestartPolicy": {"Name": spec.get("restart") or "unless-stopped"}}}
    task.step(f"Creating container {name}")
    cid = d.post("/containers/create", {"name": name}, body=body)["Id"]
    d.post(f"/containers/{cid}/start")
    return {"path": real, "id": cid}


def down_project(task, path):
    real, kind, entry = allowed_project(path)
    if kind == "compose":
        task.step(f"Removing containers of {real}")
        run_cmd(task, _compose_base(real, entry) + ["down"], cwd=real)
    else:
        for c in d.get("/containers/json", {"all": True}) or []:
            if (c.get("Labels") or {}).get("drydock.project.dir") == real:
                remove(c["Id"])
    return {"path": real}


def delete_import(path):
    real = os.path.realpath(path)
    base = os.path.realpath(IMPORTS)
    if os.path.dirname(real) != base:
        raise ValueError("only imported projects can be deleted")
    shutil.rmtree(real)
