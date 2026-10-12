"""Task engine: every change runs as a task and shows up in Recent tasks."""
import itertools
import threading
import time
import traceback

from . import store
from .dockerapi import DockerError

_lock = threading.Lock()
_tasks = {}
_ids = itertools.count(int(time.time()))
MAX_LOG = 4000


class Task:
    def __init__(self, name, target, user):
        self.id = next(_ids)
        self.name = name
        self.target = target
        self.user = user
        self.queued = time.time()
        self.started = None
        self.finished = None
        self.state = "queued"
        self.error = ""
        self.progress = ""
        self.lines = []
        self.result = None

    def log(self, line):
        line = str(line).rstrip("\n")
        with _lock:
            self.lines.append(line)
            if len(self.lines) > MAX_LOG:
                del self.lines[:500]

    def step(self, text):
        self.progress = text
        self.log(text)

    def brief(self):
        return {"id": self.id, "name": self.name, "target": self.target,
                "user": self.user, "queued": self.queued, "started": self.started,
                "finished": self.finished, "state": self.state, "error": self.error,
                "progress": self.progress}

    def full(self):
        d = self.brief()
        d["log"] = "\n".join(self.lines)
        d["result"] = self.result
        return d


def _work(task, fn):
    task.started = time.time()
    task.state = "running"
    try:
        task.result = fn(task)
        task.state = "success"
    except DockerError as e:
        task.state, task.error = "error", e.message
        task.log("ERROR: " + e.message)
    except Exception as e:  # noqa: BLE001 - report anything to the user
        task.state, task.error = "error", str(e) or e.__class__.__name__
        task.log(traceback.format_exc())
    task.finished = time.time()
    task.progress = ""
    store.save_task(task.brief(), "\n".join(task.lines))


def run(name, target, user, fn):
    task = Task(name, target, user)
    with _lock:
        _tasks[task.id] = task
        if len(_tasks) > 300:
            for k in sorted(_tasks)[:100]:
                if _tasks[k].state not in ("queued", "running"):
                    del _tasks[k]
    threading.Thread(target=_work, args=(task, fn), daemon=True).start()
    return task.id


def recent(limit=40):
    with _lock:
        live = {t.id: t.brief() for t in _tasks.values()}
    for row in store.load_tasks(limit):
        live.setdefault(row["id"], row)
    return sorted(live.values(), key=lambda t: t["queued"], reverse=True)[:limit]


def detail(tid):
    with _lock:
        t = _tasks.get(tid)
    if t:
        return t.full()
    return store.load_task(tid)
