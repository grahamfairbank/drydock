"""HTTP + WebSocket server for the Drydock Host Client."""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import secrets
import shutil
import struct
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import dockerapi as d
from . import ops, store, tasks

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
USER = os.environ.get("DRYDOCK_USER", "admin")
PASSWORD = os.environ.get("DRYDOCK_PASSWORD", "")
PORT = int(os.environ.get("PORT", "9000"))
SESSION_TTL = 12 * 3600
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_sessions = {}
_cache = {}
_cache_lock = threading.Lock()


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (now, val)
    return val


def uncache(*keys):
    with _cache_lock:
        for k in keys:
            _cache.pop(k, None)


class HTTPError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- views
def container_rows():
    me = ops.self_id()
    rows = []
    for c in d.get("/containers/json", {"all": True}) or []:
        name = c["Names"][0].lstrip("/")
        labels = c.get("Labels") or {}
        status = c.get("Status", "")
        health = ""
        m = re.search(r"\((healthy|unhealthy|health: starting)\)", status)
        if m:
            health = m.group(1).replace("health: ", "")
        exit_code = None
        m = re.match(r"Exited \((\d+)\)", status)
        if m:
            exit_code = int(m.group(1))
        ports = sorted({(p.get("PublicPort"), p.get("PrivatePort"), p.get("Type"))
                        for p in c.get("Ports") or [] if p.get("PublicPort")})
        rows.append({
            "id": c["Id"], "name": name, "image": c.get("Image", ""), "state": c.get("State", ""),
            "status": status, "health": health, "exit_code": exit_code, "created": c.get("Created"),
            "project": labels.get("com.docker.compose.project", ""),
            "service": labels.get("com.docker.compose.service", ""),
            "ports": [{"host": p[0], "container": p[1], "proto": p[2]} for p in ports],
            "network_mode": (c.get("HostConfig") or {}).get("NetworkMode", ""),
            "self": bool(me and c["Id"].startswith(me)),
            "stats": store.collector.latest.get(name) if c.get("State") == "running" else None,
            "spark": list(store.collector.spark.get(name, ())) if c.get("State") == "running" else [],
            "Labels": labels})
    return rows


def host_info():
    info = cached("info", 30, lambda: d.get("/info"))
    static = cached("static", 30, store.host_static)
    return {"name": info.get("Name"), "os": info.get("OperatingSystem"),
            "kernel": info.get("KernelVersion"), "arch": info.get("Architecture"),
            "ncpu": info.get("NCPU"), "mem_total": info.get("MemTotal"),
            "docker": info.get("ServerVersion"), "driver": info.get("Driver"),
            "root_dir": info.get("DockerRootDir"), "cgroup": info.get("CgroupVersion"),
            "images": info.get("Images"), "cpu_model": static["cpu_model"],
            "uptime": static["uptime"], "version": ops.VERSION,
            "projects_root": ops.ROOT, "stats": store.collector.host}


def alarms(rows, host):
    out = []
    for c in rows:
        if c["state"] == "restarting":
            out.append({"level": "error", "target": c["name"], "text": "is stuck in a restart loop"})
        elif c["health"] == "unhealthy":
            out.append({"level": "error", "target": c["name"], "text": "is failing its health check"})
        elif c["state"] == "exited" and c["exit_code"] not in (None, 0, 137, 143):
            out.append({"level": "warn", "target": c["name"],
                        "text": f"exited with status {c['exit_code']}"})
        s = c["stats"]
        if s and s.get("mem_limit") and host["mem_total"] and s["mem_limit"] < host["mem_total"] * 0.99 \
                and s["mem"] > 0.9 * s["mem_limit"]:
            out.append({"level": "warn", "target": c["name"], "text": "is above 90% of its memory limit"})
    hs = host.get("stats") or {}
    if hs.get("disk_total") and hs["disk"] / hs["disk_total"] > 0.85:
        out.append({"level": "warn", "target": "", "text": "Host storage is more than 85% full"})
    if hs.get("mem_total") and hs["mem"] / hs["mem_total"] > 0.92:
        out.append({"level": "warn", "target": "", "text": "Host memory is more than 92% used"})
    return out


def overview():
    rows = container_rows()
    host = host_info()
    counts = cached("counts", 15, lambda: {
        "images": len(d.get("/images/json") or []),
        "volumes": len((d.get("/volumes") or {}).get("Volumes") or []),
        "networks": len(d.get("/networks") or [])})
    for r in rows:
        r.pop("Labels", None)
    return {"host": host, "containers": rows, "alarms": alarms(rows, host),
            "counts": counts, "tasks": tasks.recent(40), "now": time.time()}


def container_detail(cid):
    insp = d.get(f"/containers/{cid}/json")
    name = ops.cname(insp)
    me = ops.self_id()
    return {"inspect": insp, "name": name, "note": store.get_note(name),
            "self": bool(me and insp["Id"].startswith(me)),
            "stats": store.collector.latest.get(name)}


def images_view():
    used = {}
    for c in d.get("/containers/json", {"all": True}) or []:
        used.setdefault(c.get("ImageID"), []).append(c["Names"][0].lstrip("/"))
    out = []
    for i in d.get("/images/json") or []:
        labels = i.get("Labels") or {}
        tags = [t for t in (i.get("RepoTags") or []) if t != "<none>:<none>"]
        out.append({"id": i["Id"], "tags": tags, "size": i.get("Size", 0),
                    "created": i.get("Created"), "used_by": used.get(i["Id"], []),
                    "snapshot_of": labels.get("drydock.snapshot.of", "")})
    return out


def volumes_view():
    df = cached("df", 60, lambda: d.get("/system/df", timeout=120))
    sizes = {v["Name"]: (v.get("UsageData") or {}).get("Size", -1) for v in df.get("Volumes") or []}
    used = {}
    for c in d.get("/containers/json", {"all": True}) or []:
        for m in c.get("Mounts") or []:
            if m.get("Type") == "volume":
                used.setdefault(m.get("Name"), []).append(c["Names"][0].lstrip("/"))
    out = []
    for v in (d.get("/volumes") or {}).get("Volumes") or []:
        out.append({"name": v["Name"], "driver": v.get("Driver"), "created": v.get("CreatedAt"),
                    "mountpoint": v.get("Mountpoint"), "size": sizes.get(v["Name"], -1),
                    "used_by": used.get(v["Name"], []),
                    "project": (v.get("Labels") or {}).get("com.docker.compose.project", "")})
    return out


def networks_view():
    out = []
    for n in d.get("/networks") or []:
        full = d.get(f"/networks/{n['Id']}")
        cfg = (full.get("IPAM") or {}).get("Config") or []
        out.append({"id": n["Id"], "name": n["Name"], "driver": n.get("Driver"),
                    "scope": n.get("Scope"), "internal": n.get("Internal", False),
                    "subnet": ", ".join(c.get("Subnet", "") for c in cfg),
                    "gateway": ", ".join(c.get("Gateway", "") for c in cfg if c.get("Gateway")),
                    "containers": sorted(
                        [{"name": c.get("Name"), "ip": c.get("IPv4Address", "").split("/")[0]}
                         for c in (full.get("Containers") or {}).values()], key=lambda c: c["name"])})
    return sorted(out, key=lambda n: n["name"])


def storage_summary():
    df = cached("df", 60, lambda: d.get("/system/df", timeout=120))
    total, used = store.disk_usage()
    return {"disk_total": total, "disk_used": used,
            "images": sum(i.get("Size", 0) for i in df.get("Images") or []),
            "volumes": sum(max(0, (v.get("UsageData") or {}).get("Size", 0)) for v in df.get("Volumes") or []),
            "containers": sum(c.get("SizeRw", 0) or 0 for c in df.get("Containers") or []),
            "build_cache": sum(b.get("Size", 0) for b in df.get("BuildCache") or []),
            "exports": sum(e["size"] for e in ops.list_exports())}


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Drydock"

    def log_message(self, fmt, *args):
        pass

    # -- plumbing
    def send_json(self, obj, status=200, headers=None):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 4 << 20:
            raise HTTPError(413, "request too large")
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw) if raw else {}
        except ValueError:
            raise HTTPError(400, "invalid JSON")

    def session(self):
        cookie = self.headers.get("Cookie", "")
        m = re.search(r"(?:^|;\s*)drydock_session=([\w-]+)", cookie)
        if not m:
            return None
        s = _sessions.get(m.group(1))
        if not s or s["expires"] < time.time():
            _sessions.pop(m.group(1), None)
            return None
        s["expires"] = time.time() + SESSION_TTL
        s["token"] = m.group(1)
        return s

    def serve_static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.realpath(os.path.join(WEB, rel))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            raise HTTPError(404, "not found")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(full)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400" if "/vendor/" in full else "no-cache")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def dispatch(self, method):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        self.q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            if path == "/healthz":
                return self.send_json({"ok": True})
            if not path.startswith("/api/"):
                if method != "GET":
                    raise HTTPError(405, "method not allowed")
                return self.serve_static(path)
            if method != "GET" and self.headers.get("X-Drydock") != "1":
                raise HTTPError(403, "missing X-Drydock header")
            if path == "/api/login" and method == "POST":
                return self.login()
            sess = self.session()
            if path == "/api/session":
                return self.send_json({"user": sess["user"] if sess else None})
            if not sess:
                raise HTTPError(401, "not signed in")
            self.user = sess["user"]
            if path == "/api/logout":
                _sessions.pop(sess["token"], None)
                return self.send_json({"ok": True})
            return self.api(method, path)
        except HTTPError as e:
            self.fail(e.status, e.message)
        except d.DockerError as e:
            self.fail(e.status if e.status in (400, 404, 409) else 500, e.message)
        except (ValueError, FileNotFoundError) as e:
            self.fail(400, str(e) or "bad request")
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as e:  # noqa: BLE001 - never let a request kill the thread silently
            self.fail(500, f"{e.__class__.__name__}: {e}")

    def fail(self, status, message):
        self.close_connection = True
        try:
            self.send_json({"error": message}, status, {"Connection": "close"})
        except OSError:
            pass

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def login(self):
        b = self.body()
        ok = hmac.compare_digest(str(b.get("user", "")).encode(), USER.encode()) & \
            hmac.compare_digest(str(b.get("password", "")).encode(), PASSWORD.encode())
        if not ok:
            time.sleep(1.5)
            raise HTTPError(401, "Cannot complete login due to an incorrect user name or password.")
        token = secrets.token_urlsafe(32)
        _sessions[token] = {"user": USER, "expires": time.time() + SESSION_TTL}
        for k in [k for k, s in _sessions.items() if s["expires"] < time.time()]:
            del _sessions[k]
        self.send_json({"user": USER}, headers={
            "Set-Cookie": f"drydock_session={token}; Path=/; HttpOnly; SameSite=Strict"})

    def task(self, name, target, fn):
        def wrapped(t):
            try:
                return fn(t)
            finally:
                uncache("counts", "df")
        self.send_json({"task": tasks.run(name, target, self.user, wrapped)})

    # -- API
    def api(self, method, path):
        q = self.q
        G, P, D = method == "GET", method == "POST", method == "DELETE"
        if G and path == "/api/overview":
            return self.send_json(overview())
        if G and path == "/api/metrics":
            if q.get("top"):
                return self.send_json(store.top_series(q["top"], q.get("range", "1h")))
            return self.send_json(store.series(q.get("target", "_host"), q.get("range", "1h")))
        if G and path == "/api/trends":
            return self.send_json(cached("trends", 30, store.trends))
        if G and path == "/api/events":
            return self.send_json(store.events(int(q.get("limit", 200)), q.get("name")))
        if G and path == "/api/images":
            return self.send_json(images_view())
        if G and path == "/api/volumes":
            return self.send_json(volumes_view())
        if G and path == "/api/networks":
            return self.send_json(networks_view())
        if G and path == "/api/storage":
            return self.send_json(storage_summary())
        if G and path == "/api/exports":
            return self.send_json(ops.list_exports())
        if G and path == "/api/projects":
            return self.send_json(ops.list_projects(d.get("/containers/json", {"all": True}) or []))
        if G and path == "/api/projects/file":
            return self.send_json(ops.project_file(q.get("path", "")))

        m = re.fullmatch(r"/api/tasks/(\d+)", path)
        if G and m:
            t = tasks.detail(int(m.group(1)))
            if not t:
                raise HTTPError(404, "no such task")
            return self.send_json(t)

        m = re.fullmatch(r"/api/containers/([\w.-]+)(?:/([\w/]+))?", path)
        if m:
            return self.container_api(method, m.group(1), m.group(2) or "")

        if P and path == "/api/create":
            b = self.body()
            return self.task("Create container", b.get("name", ""), lambda t: ops.create(t, b))
        if P and path == "/api/export":
            b = self.body()
            ids = b.get("ids") or []
            names = [ops.cname(d.get(f"/containers/{i}/json")) for i in ids]
            return self.task("Export container", ", ".join(names), lambda t: ops.export(
                t, ids, bool(b.get("commit")), b.get("volumes", True), bool(b.get("source"))))
        if P and path == "/api/images/pull":
            ref = self.body().get("ref", "").strip()
            if not ref:
                raise HTTPError(400, "image reference required")
            return self.task("Pull image", ref, lambda t: ops.pull(t, ref))
        if P and path == "/api/images/prune":
            return self.task("Prune unused images", "", lambda t: t.log(json.dumps(
                d.post("/images/prune", {"filters": {"dangling": ["true"]}}), indent=1)))
        m = re.fullmatch(r"/api/images/(sha256:[0-9a-f]+)", path)
        if D and m:
            img = m.group(1)
            return self.task("Delete image", q.get("label", img[7:19]),
                             lambda t: d.delete(f"/images/{img}", {"force": q.get("force") == "1"}))
        m = re.fullmatch(r"/api/volumes/([\w.-]+)", path)
        if D and m:
            vol = m.group(1)
            return self.task("Delete volume", vol, lambda t: d.delete(f"/volumes/{vol}"))
        m = re.fullmatch(r"/api/networks/([0-9a-f]+)", path)
        if D and m:
            net = m.group(1)
            return self.task("Delete network", q.get("label", net[:12]),
                             lambda t: d.delete(f"/networks/{net}"))

        m = re.fullmatch(r"/api/exports/([^/]+)(/deploy)?", path)
        if m:
            fpath = ops.safe_file(ops.EXPORTS, m.group(1))
            if G and not m.group(2):
                return self.send_file(fpath)
            if D and not m.group(2):
                os.remove(fpath)
                return self.send_json({"ok": True})
            if G and m.group(2):
                return self.send_json(ops.classify(fpath))
            if P and m.group(2):
                return self.start_import(fpath, self.body(), keep=True)
        if method == "PUT" and path == "/api/upload":
            return self.upload()
        if P and path == "/api/import":
            b = self.body()
            return self.start_import(ops.safe_file(ops.UPLOADS, b.get("upload", "")), b, keep=False)
        if P and path == "/api/git":
            b = self.body()
            def job(t):
                res = ops.git_clone(t, b.get("url", "").strip(), b.get("name", "").strip())
                if b.get("deploy"):
                    ops.deploy_project(t, res["path"], b)
                return res
            return self.task("Import from Git", b.get("url", ""), job)
        if P and path == "/api/projects/deploy":
            b = self.body()
            real = ops.allowed_project(b.get("path", ""))[0]
            return self.task("Deploy project", os.path.basename(real),
                             lambda t: ops.deploy_project(t, real, b))
        if P and path == "/api/projects/down":
            b = self.body()
            real = ops.allowed_project(b.get("path", ""))[0]
            return self.task("Unregister project", os.path.basename(real),
                             lambda t: ops.down_project(t, real))
        if P and path == "/api/projects/delete":
            ops.delete_import(self.body().get("path", ""))
            return self.send_json({"ok": True})
        raise HTTPError(404, "no such endpoint")

    def container_api(self, method, cid, sub):
        G, P, D = method == "GET", method == "POST", method == "DELETE"
        q = self.q
        if G and sub == "":
            return self.send_json(container_detail(cid))
        if G and sub == "console":
            return self.console(cid)
        if G and sub == "logs":
            insp = d.get(f"/containers/{cid}/json")
            text = d.logs(cid, int(q.get("tail", 300)), insp["Config"].get("Tty", False))
            return self.send_json({"text": text.decode("utf-8", "replace")})
        if G and sub == "logs/stream":
            return self.log_stream(cid)
        if G and sub == "top":
            try:
                return self.send_json(d.get(f"/containers/{cid}/top", {"ps_args": "-eo pid,user,pcpu,pmem,etime,args"}))
            except d.DockerError:
                return self.send_json(d.get(f"/containers/{cid}/top"))
        if G and sub == "snapshots":
            return self.send_json(ops.snapshots(ops.cname(d.get(f"/containers/{cid}/json"))))
        if D and sub == "":
            name = ops.cname(d.get(f"/containers/{cid}/json"))
            return self.task("Delete container", name,
                             lambda t: ops.remove(cid, q.get("volumes") == "1"))
        if not P:
            raise HTTPError(405, "method not allowed")
        insp = d.get(f"/containers/{cid}/json")
        name = ops.cname(insp)
        labels = {"start": "Power on", "stop": "Power off", "restart": "Restart", "pause": "Suspend",
                  "unpause": "Resume", "kill": "Kill"}
        if sub in labels:
            return self.task(labels[sub] + " container", name, lambda t: ops.power(cid, sub))
        b = self.body()
        if sub == "rename":
            new = ops.check_name(b.get("name", ""))
            ops.guard_self(insp, "rename")
            return self.task("Rename container", name,
                             lambda t: d.post(f"/containers/{cid}/rename", {"name": new}))
        if sub == "update":
            return self.task("Reconfigure container", name, lambda t: ops.update(
                cid, b.get("restart"), b.get("memory"), b.get("cpus")))
        if sub == "note":
            store.set_note(name, str(b.get("text", ""))[:4000])
            return self.send_json({"ok": True})
        if sub == "snapshot":
            return self.task("Take snapshot", name, lambda t: ops.snapshot(
                t, cid, str(b.get("name", ""))[:80], str(b.get("comment", ""))[:300]))
        if sub == "revert":
            ref = b.get("ref", "")
            if not ref.startswith(ops.SNAP_REPO + "/"):
                raise HTTPError(400, "not a snapshot")
            return self.task("Revert to snapshot", name, lambda t: ops.revert(t, cid, ref))
        raise HTTPError(404, "no such endpoint")

    # -- import / export plumbing
    def start_import(self, fpath, b, keep):
        info = ops.classify(fpath)
        kind = info["kind"]
        label = os.path.basename(fpath)

        def job(t):
            try:
                if kind == "bundle":
                    return ops.import_bundle(t, fpath, b.get("names"), b.get("start", True),
                                             b.get("restore_volumes", True))
                if kind == "image":
                    return ops.import_image(t, fpath)
                if kind == "project":
                    res = ops.import_project(t, fpath, b.get("name", ""))
                    if b.get("deploy"):
                        ops.deploy_project(t, res["path"], b)
                    return res
                raise ValueError("unrecognised archive: expected a Drydock bundle, a docker "
                                 "image archive, or a project with a compose file or Dockerfile")
            finally:
                if not keep:
                    try:
                        os.remove(fpath)
                    except OSError:
                        pass
        names = {"bundle": "Import bundle", "image": "Import image", "project": "Import project"}
        self.task(names.get(kind, "Import"), label, job)

    def upload(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise HTTPError(400, "empty upload")
        if shutil.disk_usage(ops.UPLOADS).free < length * 2.2:
            self.close_connection = True
            raise HTTPError(507, "not enough free space on the datastore")
        name = re.sub(r"[^\w.+-]", "_", os.path.basename(self.q.get("name", "upload")))[:120] or "upload"
        for f in os.listdir(ops.UPLOADS):
            p = os.path.join(ops.UPLOADS, f)
            if time.time() - os.path.getmtime(p) > 6 * 3600:
                os.remove(p)
        stored = f"{secrets.token_hex(4)}-{name}"
        dest = os.path.join(ops.UPLOADS, stored)
        left = length
        try:
            with open(dest, "wb") as f:
                while left:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise HTTPError(400, "upload interrupted")
                    f.write(chunk)
                    left -= len(chunk)
        except Exception:
            if os.path.exists(dest):
                os.remove(dest)
            self.close_connection = True
            raise
        info = ops.classify(dest)
        info.update({"upload": stored, "name": name, "size": length})
        self.send_json(info)

    def send_file(self, fpath):
        size = os.path.getsize(fpath)
        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(fpath)}"')
        self.end_headers()
        with open(fpath, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)

    # -- streaming
    def log_stream(self, cid):
        insp = d.get(f"/containers/{cid}/json")
        resp = d.request("GET", f"/containers/{cid}/logs", {
            "stdout": 1, "stderr": 1, "follow": 1, "tail": int(self.q.get("tail", 300))},
            timeout=None, stream=True)
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        chunks = queue.Queue(maxsize=256)

        def pump():
            demux = d.Demux(insp["Config"].get("Tty", False))
            try:
                while True:
                    data = resp.read1(65536)
                    if not data:
                        break
                    out = demux.feed(data)
                    if out:
                        chunks.put(out)
            except Exception:  # noqa: BLE001 - stream closed from either side
                pass
            chunks.put(None)

        threading.Thread(target=pump, daemon=True).start()
        try:
            while True:
                try:
                    out = chunks.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    continue
                if out is None:
                    self.wfile.write(b"event: end\ndata: {}\n\n")
                    break
                payload = json.dumps(out.decode("utf-8", "replace"))
                self.wfile.write(f"data: {payload}\n\n".encode())
        except OSError:
            pass
        finally:
            d.close_stream(resp)

    def console(self, cid):
        """Interactive shell in the container over a WebSocket."""
        key = self.headers.get("Sec-WebSocket-Key")
        origin = urllib.parse.urlsplit(self.headers.get("Origin", "")).netloc
        if not key or self.headers.get("Upgrade", "").lower() != "websocket":
            raise HTTPError(400, "websocket upgrade expected")
        if origin != self.headers.get("Host"):
            raise HTTPError(403, "cross-origin console refused")
        shell = "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"
        exec_id = d.post(f"/containers/{cid}/exec", body={
            "AttachStdin": True, "AttachStdout": True, "AttachStderr": True, "Tty": True,
            "Env": ["TERM=xterm-256color"], "Cmd": ["/bin/sh", "-c", shell]})["Id"]
        sock, rest = d.hijack(f"/exec/{exec_id}/start", {"Detach": False, "Tty": True})
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.close_connection = True
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        client = self.connection
        wlock = threading.Lock()

        def send(payload, opcode=2):
            n = len(payload)
            if n < 126:
                head = bytes([0x80 | opcode, n])
            elif n < 65536:
                head = bytes([0x80 | opcode, 126]) + struct.pack(">H", n)
            else:
                head = bytes([0x80 | opcode, 127]) + struct.pack(">Q", n)
            with wlock:
                client.sendall(head + payload)

        def pump():
            try:
                if rest:
                    send(rest)
                while True:
                    data = sock.recv(65536)
                    if not data:
                        break
                    send(data)
                send(b"", 8)
            except OSError:
                pass
            try:
                client.shutdown(2)
            except OSError:
                pass

        threading.Thread(target=pump, daemon=True).start()
        try:
            while True:
                head = self.rfile.read(2)
                if len(head) < 2:
                    break
                opcode, n = head[0] & 0x0F, head[1] & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self.rfile.read(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self.rfile.read(8))[0]
                if n > 1 << 20:
                    break
                mask = self.rfile.read(4) if head[1] & 0x80 else b"\0\0\0\0"
                data = bytearray(self.rfile.read(n))
                for i in range(len(data)):
                    data[i] ^= mask[i & 3]
                if opcode == 8:
                    break
                if opcode == 9:
                    send(bytes(data), 10)
                elif opcode == 1:
                    try:
                        msg = json.loads(data)
                        cols, rows = int(msg["resize"][0]), int(msg["resize"][1])
                        d.post(f"/exec/{exec_id}/resize", {"w": cols, "h": rows})
                    except (ValueError, KeyError, TypeError, d.DockerError):
                        pass
                elif opcode in (0, 2):
                    sock.sendall(bytes(data))
        except OSError:
            pass
        finally:
            for fn in (lambda: sock.shutdown(2), sock.close):
                try:
                    fn()
                except OSError:
                    pass


def main():
    if not PASSWORD:
        raise SystemExit("DRYDOCK_PASSWORD must be set")
    store.init()
    ops.init()
    store.collector.start()
    store.EventListener(name="events").start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    print(f"Drydock {ops.VERSION} listening on :{PORT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
