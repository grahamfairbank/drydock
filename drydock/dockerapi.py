"""Minimal Docker Engine API client over the unix socket (stdlib only)."""
import http.client
import json
import os
import socket
import struct
import urllib.parse

SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")


class DockerError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class _Conn(http.client.HTTPConnection):
    def __init__(self, timeout):
        super().__init__("docker", timeout=timeout)

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(SOCK)
        self.sock = s


def _path(path, query):
    if query:
        q = {}
        for k, v in query.items():
            if v is None:
                continue
            if isinstance(v, bool):
                v = "true" if v else "false"
            elif isinstance(v, (dict, list)):
                v = json.dumps(v)
            q[k] = v
        path += "?" + urllib.parse.urlencode(q)
    return path


def request(method, path, query=None, body=None, raw=None, headers=None,
            timeout=60, stream=False):
    """Call the API. Returns bytes, or the open response when stream=True
    (close it with close_stream)."""
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    elif raw is not None:
        data = raw
        h.setdefault("Content-Type", "application/x-tar")
    conn = _Conn(timeout)
    try:
        conn.request(method, _path(path, query), body=data, headers=h)
        resp = conn.getresponse()
    except Exception:
        conn.close()
        raise
    if resp.status >= 400:
        text = resp.read()
        conn.close()
        try:
            msg = json.loads(text)["message"]
        except Exception:
            msg = text.decode("utf-8", "replace").strip() or resp.reason
        raise DockerError(resp.status, msg)
    if stream:
        resp._drydock_conn = conn
        return resp
    try:
        return resp.read()
    finally:
        conn.close()


def close_stream(resp):
    conn = getattr(resp, "_drydock_conn", None)
    try:
        if conn and conn.sock:
            try:
                conn.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        resp.close()
    except Exception:
        pass
    if conn:
        conn.close()


def get(path, query=None, timeout=60):
    data = request("GET", path, query, timeout=timeout)
    return json.loads(data) if data else None


def post(path, query=None, body=None, timeout=120):
    data = request("POST", path, query, body=body, timeout=timeout)
    if not data:
        return None
    try:
        return json.loads(data)
    except ValueError:
        return data


def delete(path, query=None, timeout=120):
    data = request("DELETE", path, query, timeout=timeout)
    try:
        return json.loads(data) if data else None
    except ValueError:
        return None


class Demux:
    """Incremental parser for Docker's multiplexed stdout/stderr stream."""

    def __init__(self, tty):
        self.tty = tty
        self.buf = b""

    def feed(self, chunk):
        if self.tty:
            return chunk
        self.buf += chunk
        out = []
        while len(self.buf) >= 8:
            size = struct.unpack(">I", self.buf[4:8])[0]
            if len(self.buf) < 8 + size:
                break
            out.append(self.buf[8:8 + size])
            self.buf = self.buf[8 + size:]
        return b"".join(out)


def logs(cid, tail=200, tty=False):
    data = request("GET", f"/containers/{cid}/logs",
                   {"stdout": 1, "stderr": 1, "tail": tail}, timeout=30)
    return Demux(tty).feed(data)


def hijack(path, body):
    """POST with a connection upgrade; returns (socket, leftover bytes)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(SOCK)
    payload = json.dumps(body).encode()
    s.sendall((f"POST {path} HTTP/1.1\r\nHost: docker\r\n"
               "Content-Type: application/json\r\nConnection: Upgrade\r\n"
               f"Upgrade: tcp\r\nContent-Length: {len(payload)}\r\n\r\n").encode() + payload)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].split(b" ")
    code = int(status[1]) if len(status) > 1 and status[1].isdigit() else 0
    if code not in (101, 200):
        s.close()
        raise DockerError(code or 500, rest.decode("utf-8", "replace") or "exec failed")
    return s, rest
