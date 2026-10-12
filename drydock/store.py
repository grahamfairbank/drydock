"""SQLite storage, the metrics collector and the Docker event listener."""
import collections
import json
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import dockerapi as d

DATA = os.environ.get("DRYDOCK_DATA", "/data")
ROOT = os.environ.get("DRYDOCK_PROJECTS_ROOT", "/projects")
HOST_PROC = "/host/proc" if os.path.isdir("/host/proc/1") else "/proc"
INTERVAL = 10
# resolution -> (seconds per point, retention seconds)
RES = {0: (INTERVAL, 2 * 3600), 1: (60, 48 * 3600), 2: (600, 30 * 86400)}
RANGES = {"1h": (3600, 0), "6h": (6 * 3600, 1), "24h": (86400, 1),
          "7d": (7 * 86400, 2), "30d": (30 * 86400, 2)}
FIELDS = ("cpu", "mem", "mem_limit", "rx", "tx", "br", "bw", "pids")
HFIELDS = ("cpu", "mem", "mem_total", "disk", "disk_total", "rx", "tx", "load1", "running")

_local = threading.local()


def db():
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(DATA, exist_ok=True)
        conn = sqlite3.connect(os.path.join(DATA, "drydock.db"), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return conn


def init():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS samples(ts INTEGER, res INTEGER, name TEXT,
      cpu REAL, mem REAL, mem_limit REAL, rx REAL, tx REAL, br REAL, bw REAL, pids REAL);
    CREATE INDEX IF NOT EXISTS samples_i ON samples(res, name, ts);
    CREATE TABLE IF NOT EXISTS host(ts INTEGER, res INTEGER, cpu REAL, mem REAL,
      mem_total REAL, disk REAL, disk_total REAL, rx REAL, tx REAL, load1 REAL, running REAL);
    CREATE INDEX IF NOT EXISTS host_i ON host(res, ts);
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, queued REAL, brief TEXT, log TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL,
      type TEXT, action TEXT, name TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS notes(name TEXT PRIMARY KEY, text TEXT);
    """)
    c.commit()


# ---------------------------------------------------------------- tasks/notes
def save_task(brief, log):
    c = db()
    c.execute("INSERT OR REPLACE INTO tasks VALUES(?,?,?,?)",
              (brief["id"], brief["queued"], json.dumps(brief), log[-200000:]))
    c.execute("DELETE FROM tasks WHERE id NOT IN (SELECT id FROM tasks ORDER BY queued DESC LIMIT 500)")
    c.commit()


def load_tasks(limit):
    rows = db().execute("SELECT brief FROM tasks ORDER BY queued DESC LIMIT ?", (limit,))
    return [json.loads(r["brief"]) for r in rows]


def load_task(tid):
    r = db().execute("SELECT brief, log FROM tasks WHERE id=?", (tid,)).fetchone()
    if not r:
        return None
    t = json.loads(r["brief"])
    t["log"] = r["log"]
    return t


def get_note(name):
    r = db().execute("SELECT text FROM notes WHERE name=?", (name,)).fetchone()
    return r["text"] if r else ""


def set_note(name, text):
    c = db()
    c.execute("INSERT OR REPLACE INTO notes VALUES(?,?)", (name, text))
    c.commit()


def events(limit=200, name=None):
    q, args = "SELECT ts,type,action,name,detail FROM events", []
    if name:
        q += " WHERE name=?"
        args.append(name)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    return [dict(r) for r in db().execute(q, args)]


# ---------------------------------------------------------------- host probes
def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def host_static():
    model = ""
    for line in _read(HOST_PROC + "/cpuinfo").splitlines():
        if line.lower().startswith(("model name", "hardware")):
            model = line.split(":", 1)[1].strip()
            break
    up = _read(HOST_PROC + "/uptime").split()
    return {"cpu_model": model, "uptime": float(up[0]) if up else 0}


def _cpu_times():
    parts = _read(HOST_PROC + "/stat").split("\n", 1)[0].split()[1:]
    vals = [int(x) for x in parts[:8]] or [0] * 8
    idle = vals[3] + vals[4]
    return sum(vals), idle


def _meminfo():
    info = {}
    for line in _read(HOST_PROC + "/meminfo").splitlines():
        k, _, v = line.partition(":")
        info[k] = int(v.split()[0]) * 1024 if v.split() else 0
    total = info.get("MemTotal", 0)
    return total, total - info.get("MemAvailable", 0)


def _netdev():
    rx = tx = 0
    text = _read(HOST_PROC + "/1/net/dev") or _read("/proc/net/dev")
    for line in text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        if name == "lo" or name.startswith(("veth", "br-", "docker", "virbr", "lxd")):
            continue
        f = rest.split()
        if len(f) >= 9:
            rx += int(f[0])
            tx += int(f[8])
    return rx, tx


def disk_usage():
    path = ROOT if os.path.isdir(ROOT) else DATA
    try:
        s = os.statvfs(path)
        total = s.f_blocks * s.f_frsize
        return total, total - s.f_bavail * s.f_frsize
    except OSError:
        return 0, 0


# ---------------------------------------------------------------- collector
class Collector(threading.Thread):
    daemon = True

    def __init__(self):
        super().__init__(name="collector")
        self.latest = {}       # container name -> latest sample
        self.host = {}
        self.spark = collections.defaultdict(lambda: collections.deque(maxlen=40))
        self._prev = {}        # container id -> raw counters
        self._hprev = None
        self._acc = {1: {}, 2: {}}
        self._hacc = {1: [], 2: []}
        self._flushed = {1: time.time(), 2: time.time()}
        self._pool = ThreadPoolExecutor(8)

    def _stat(self, c):
        cid = c["Id"]
        name = c["Names"][0].lstrip("/")
        try:
            s = d.get(f"/containers/{cid}/stats", {"stream": False, "one-shot": True}, timeout=8)
        except Exception:
            return None
        now = time.time()
        cpu_ns = s.get("cpu_stats", {}).get("cpu_usage", {}).get("total_usage", 0)
        ms = s.get("memory_stats", {})
        st = ms.get("stats", {})
        mem = max(0, ms.get("usage", 0) - st.get("inactive_file", st.get("total_inactive_file", 0)))
        rx = tx = 0
        for n in (s.get("networks") or {}).values():
            rx += n.get("rx_bytes", 0)
            tx += n.get("tx_bytes", 0)
        br = bw = 0
        for e in (s.get("blkio_stats", {}).get("io_service_bytes_recursive") or []):
            if e.get("op", "").lower() == "read":
                br += e.get("value", 0)
            elif e.get("op", "").lower() == "write":
                bw += e.get("value", 0)
        prev = self._prev.get(cid)
        self._prev[cid] = (now, cpu_ns, rx, tx, br, bw)
        out = {"name": name, "ts": now, "mem": mem, "mem_limit": ms.get("limit", 0),
               "pids": s.get("pids_stats", {}).get("current", 0),
               "cpu": 0.0, "rx": 0.0, "tx": 0.0, "br": 0.0, "bw": 0.0,
               "rx_total": rx, "tx_total": tx}
        if prev and now > prev[0]:
            dt = now - prev[0]
            out["cpu"] = max(0.0, (cpu_ns - prev[1]) / 1e9 / dt * 100)
            for key, i, cur in (("rx", 2, rx), ("tx", 3, tx), ("br", 4, br), ("bw", 5, bw)):
                out[key] = max(0.0, (cur - prev[i]) / dt)
        elif not prev:
            out["first"] = True
        return out

    def _host_sample(self, running):
        now = time.time()
        total, idle = _cpu_times()
        mem_total, mem = _meminfo()
        disk_total, disk = disk_usage()
        rx, tx = _netdev()
        load = _read(HOST_PROC + "/loadavg").split()
        prev, self._hprev = self._hprev, (now, total, idle, rx, tx)
        h = {"ts": now, "cpu": 0.0, "mem": mem, "mem_total": mem_total, "disk": disk,
             "disk_total": disk_total, "rx": 0.0, "tx": 0.0,
             "load1": float(load[0]) if load else 0.0, "running": running}
        if prev:
            dt = now - prev[0]
            dtot = total - prev[1]
            if dtot > 0:
                h["cpu"] = max(0.0, min(100.0, 100.0 * (1 - (idle - prev[2]) / dtot)))
            if dt > 0:
                h["rx"] = max(0.0, (rx - prev[3]) / dt)
                h["tx"] = max(0.0, (tx - prev[4]) / dt)
        return h

    def tick(self):
        running = d.get("/containers/json", timeout=10) or []
        samples = [s for s in self._pool.map(self._stat, running) if s]
        ids = {c["Id"] for c in running}
        for cid in [k for k in self._prev if k not in ids]:
            del self._prev[cid]
        h = self._host_sample(len(running))
        first_host = not self.host
        self.host = h
        self.latest = {s["name"]: s for s in samples}
        ts = int(h["ts"])
        c = db()
        for s in samples:
            if s.get("first"):
                continue
            self.spark[s["name"]].append(round(s["cpu"], 2))
            row = [s[f] for f in FIELDS]
            c.execute("INSERT INTO samples VALUES(?,0,?,?,?,?,?,?,?,?,?)", [ts, s["name"]] + row)
            for res in (1, 2):
                self._acc[res].setdefault(s["name"], []).append(row)
        if not first_host:
            hrow = [h[f] for f in HFIELDS]
            c.execute("INSERT INTO host VALUES(?,0,?,?,?,?,?,?,?,?,?)", [ts] + hrow)
            for res in (1, 2):
                self._hacc[res].append(hrow)
        for res in (1, 2):
            if h["ts"] - self._flushed[res] >= RES[res][0]:
                self._flushed[res] = h["ts"]
                for name, rows in self._acc[res].items():
                    avg = [sum(col) / len(col) for col in zip(*rows)]
                    c.execute(f"INSERT INTO samples VALUES(?,{res},?,?,?,?,?,?,?,?,?)", [ts, name] + avg)
                if self._hacc[res]:
                    avg = [sum(col) / len(col) for col in zip(*self._hacc[res])]
                    c.execute(f"INSERT INTO host VALUES(?,{res},?,?,?,?,?,?,?,?,?)", [ts] + avg)
                self._acc[res], self._hacc[res] = {}, []
                for r, (_, keep) in RES.items():
                    c.execute("DELETE FROM samples WHERE res=? AND ts<?", (r, ts - keep))
                    c.execute("DELETE FROM host WHERE res=? AND ts<?", (r, ts - keep))
        c.commit()

    def run(self):
        while True:
            start = time.time()
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001 - keep sampling whatever happens
                print("collector:", e, flush=True)
            time.sleep(max(1.0, INTERVAL - (time.time() - start)))


collector = Collector()


# ---------------------------------------------------------------- queries
def _bucket(rng):
    span, res = RANGES.get(rng, RANGES["1h"])
    step = max(RES[res][0], span // 360)
    return span, res, step


def series(target, rng):
    """Time series for one container (by name) or the host ('_host')."""
    span, res, step = _bucket(rng)
    since = int(time.time()) - span
    if target == "_host":
        cols = HFIELDS
        q = (f"SELECT (ts/{step})*{step} AS t, " + ",".join(f"AVG({f})" for f in cols) +
             " FROM host WHERE res=? AND ts>=? GROUP BY t ORDER BY t")
        rows = db().execute(q, (res, since)).fetchall()
    else:
        cols = FIELDS
        q = (f"SELECT (ts/{step})*{step} AS t, " + ",".join(f"AVG({f})" for f in cols) +
             " FROM samples WHERE res=? AND name=? AND ts>=? GROUP BY t ORDER BY t")
        rows = db().execute(q, (res, target, since)).fetchall()
    out = {"t": [r[0] for r in rows], "step": step, "from": since, "to": int(time.time())}
    for i, f in enumerate(cols):
        out[f] = [r[i + 1] for r in rows]
    return out


def top_series(metric, rng, n=6):
    """Per-container series of one metric for the busiest n containers."""
    if metric not in FIELDS:
        metric = "cpu"
    span, res, step = _bucket(rng)
    since = int(time.time()) - span
    rows = db().execute(
        f"SELECT name, (ts/{step})*{step} AS t, AVG({metric}) FROM samples "
        "WHERE res=? AND ts>=? GROUP BY name, t ORDER BY t", (res, since)).fetchall()
    by = collections.defaultdict(dict)
    for name, t, v in rows:
        by[name][t] = v
    rank = sorted(by, key=lambda k: -sum(by[k].values()) / max(1, len(by[k])))[:n]
    times = sorted({t for k in rank for t in by[k]})
    return {"t": times, "step": step, "from": since, "to": int(time.time()),
            "series": [{"name": k, "v": [by[k].get(t) for t in times]} for k in sorted(rank)]}


def _slope(points):
    """Least-squares slope (per second) and r^2 of [(t, v)]."""
    n = len(points)
    if n < 8:
        return 0.0, 0.0
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    syy = sum((p[1] - my) ** 2 for p in points)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in points)
    if sxx == 0 or syy == 0:
        return 0.0, 0.0
    return sxy / sxx, (sxy * sxy) / (sxx * syy)


def trends():
    """Compare the last hour with the last day and project growth."""
    now = int(time.time())
    c = db()
    out = {"containers": [], "host": {}}
    rows = c.execute("SELECT name, ts, cpu, mem FROM samples WHERE res=1 AND ts>=? ORDER BY ts",
                     (now - 86400,)).fetchall()
    by = collections.defaultdict(list)
    for r in rows:
        by[r[0]].append((r[1], r[2], r[3]))
    for name, pts in by.items():
        if name not in collector.latest:
            continue
        span = pts[-1][0] - pts[0][0]
        recent = [p for p in pts if p[0] >= now - 3600]
        if not recent:
            continue
        cpu_day = sum(p[1] for p in pts) / len(pts)
        cpu_hour = sum(p[1] for p in recent) / len(recent)
        mem_day = sum(p[2] for p in pts) / len(pts)
        mem_hour = sum(p[2] for p in recent) / len(recent)
        slope, r2 = _slope([(p[0], p[2]) for p in pts])
        per_hour = slope * 3600
        growing = span >= 3 * 3600 and r2 > 0.6 and mem_day > 0 and per_hour * 24 > 0.15 * mem_day
        out["containers"].append({
            "name": name, "span": span, "cpu_hour": cpu_hour, "cpu_day": cpu_day,
            "cpu_peak": max(p[1] for p in pts), "mem_hour": mem_hour, "mem_day": mem_day,
            "mem_peak": max(p[2] for p in pts), "mem_per_hour": per_hour, "mem_growing": growing})
    hrows = c.execute("SELECT ts, disk, disk_total, cpu, mem FROM host WHERE res=2 AND ts>=? ORDER BY ts",
                      (now - 7 * 86400,)).fetchall()
    if len(hrows) < 8:
        hrows = c.execute("SELECT ts, disk, disk_total, cpu, mem FROM host WHERE res=1 AND ts>=? ORDER BY ts",
                          (now - 86400,)).fetchall()
    if hrows:
        span = hrows[-1][0] - hrows[0][0]
        slope, r2 = _slope([(r[0], r[1]) for r in hrows])
        free = hrows[-1][2] - hrows[-1][1]
        h = {"span": span, "disk_per_day": slope * 86400, "disk_free": free,
             "cpu_avg": sum(r[3] for r in hrows) / len(hrows),
             "cpu_peak": max(r[3] for r in hrows),
             "mem_avg": sum(r[4] for r in hrows) / len(hrows),
             "mem_peak": max(r[4] for r in hrows), "days_to_full": None}
        if span >= 6 * 3600 and slope > 0 and r2 > 0.5:
            h["days_to_full"] = free / slope / 86400
        out["host"] = h
    return out


# ---------------------------------------------------------------- events
class EventListener(threading.Thread):
    daemon = True

    def run(self):
        while True:
            resp = None
            try:
                resp = d.request("GET", "/events", {"since": int(time.time())},
                                 timeout=None, stream=True)
                for line in resp:
                    self.handle(json.loads(line))
            except Exception as e:  # noqa: BLE001 - reconnect on any failure
                print("events:", e, flush=True)
            finally:
                if resp is not None:
                    d.close_stream(resp)
            time.sleep(3)

    def handle(self, ev):
        action = ev.get("Action", "")
        if action.startswith(("exec_", "health_status: healthy", "top", "archive", "resize")):
            return
        typ = ev.get("Type", "")
        attrs = ev.get("Actor", {}).get("Attributes", {})
        name = attrs.get("name") or ev.get("Actor", {}).get("ID", "")[:12]
        detail = ""
        if typ == "container":
            detail = attrs.get("image", "")
            if "exitCode" in attrs:
                detail += f" (exit {attrs['exitCode']})"
        elif typ == "network" and attrs.get("container"):
            detail = attrs["container"][:12]
        c = db()
        c.execute("INSERT INTO events(ts,type,action,name,detail) VALUES(?,?,?,?,?)",
                  (ev.get("timeNano", time.time() * 1e9) / 1e9, typ, action, name, detail))
        c.execute("DELETE FROM events WHERE id < (SELECT MAX(id) FROM events) - 5000")
        c.commit()
