'use strict';
/* Drydock Host Client - core: helpers, API, shell, grid, charts, dialogs. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const enc = encodeURIComponent;

const S = { ov: null, view: null, route: [], taskState: {}, user: '', colors: {}, recent: [] };
try { S.colors = JSON.parse(localStorage.getItem('drydock.colors') || '{}'); } catch { /* storage unavailable */ }
try { S.recent = JSON.parse(localStorage.getItem('drydock.recent') || '[]'); } catch { /* storage unavailable */ }

const fmt = {
  bytes(n, d = 1) {
    if (n == null || isNaN(n)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; n = Math.abs(n);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : d)) + ' ' + u[i];
  },
  rate: n => fmt.bytes(n) + '/s',
  pct: (n, d = 1) => (n == null || isNaN(n) ? '-' : n.toFixed(n >= 100 ? 0 : d) + '%'),
  dur(s) {
    if (s == null) return '-';
    s = Math.max(0, Math.floor(s));
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return `${d} day${d > 1 ? 's' : ''}, ${h} h`;
    if (h) return `${h} h ${m} min`;
    return m ? `${m} min` : `${s} s`;
  },
  date: ts => (ts ? new Date(ts * 1000).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''),
  ago(ts) { return ts ? fmt.dur(Date.now() / 1000 - ts) + ' ago' : ''; },
};

/* ---------------- API */
async function api(path, opt = {}) {
  const o = { method: opt.method || (opt.body !== undefined ? 'POST' : 'GET'), headers: { 'X-Drydock': '1' }, credentials: 'same-origin' };
  if (opt.body !== undefined) { o.body = JSON.stringify(opt.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, o);
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Your session has expired'); }
  if (!r.ok) throw new Error((data && data.error) || r.statusText || 'Request failed');
  return data;
}

/* Start a server-side task; errors surface as a toast. */
async function run(path, opt = {}) {
  try {
    const res = await api(path, { method: 'POST', ...opt });
    if (res && res.task) S.taskState[res.task] = 'queued';
    setTimeout(poll, 250); setTimeout(poll, 1500);
    return res;
  } catch (e) { toast('Operation failed', e.message, 'err'); return null; }
}

function toast(title, text = '', cls = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.innerHTML = `<b>${esc(title)}</b>${esc(text)}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), cls === 'err' ? 9000 : 4500);
}

/* ---------------- login */
function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false; closeDialog();
  clearInterval(S.timer); S.timer = null;
  setTimeout(() => $('#lu').focus(), 50);
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const r = await api('/login', { body: { user: $('#lu').value, password: $('#lp').value } });
    $('#lp').value = '';
    start(r.user);
  } catch (err) { $('#login-err').textContent = err.message; }
});
function start(user) {
  S.user = user;
  $('#login').hidden = true; $('#app').hidden = false;
  route(); poll();
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) poll(); }, 3000);
}

/* ---------------- polling + shell */
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    S.ov = await api('/overview');
    chrome();
    if (S.view && S.view.update) S.view.update(S.ov);
    trackTasks();
  } catch { /* transient; next poll retries */ } finally { polling = false; }
}

function trackTasks() {
  let finished = false;
  const first = !S.tasksSeen;
  for (const t of S.ov.tasks) {
    const prev = S.taskState[t.id];
    if (!first && prev !== t.state && (t.state === 'success' || t.state === 'error')) {
      finished = true;
      if (t.state === 'error') toast(`${t.name} failed`, `${t.target}: ${t.error}`, 'err');
    }
    S.taskState[t.id] = t.state;
  }
  S.tasksSeen = true;
  if (finished && S.view && S.view.refresh) S.view.refresh();
}

const NAV = [
  { id: 'host', label: 'Host', icon: 'host', href: '#/host' },
  { id: 'monitor', label: 'Monitor', icon: 'chart', href: '#/monitor', sub: true },
  { id: 'containers', label: 'Containers', icon: 'box', href: '#/containers', count: o => o.containers.length },
  { id: 'storage', label: 'Storage', icon: 'db', href: '#/storage', count: o => o.counts.volumes },
  { id: 'networking', label: 'Networking', icon: 'net', href: '#/networking', count: o => o.counts.networks },
  { id: 'projects', label: 'Projects', icon: 'folder', href: '#/projects' },
];

function chrome() {
  const o = S.ov, cur = S.route[0] || 'host';
  let h = `<div class="nav-h">${icon('list')}<span>Navigator</span></div>`;
  for (const n of NAV) {
    const c = o && n.count ? `<span class="badge">${n.count(o)}</span>` : '';
    h += `<a class="n ${n.sub ? 'sub' : ''} ${cur === n.id ? 'on' : ''}" href="${n.href}" title="${n.label}">${icon(n.icon)}<span>${n.label}</span>${c}</a>`;
  }
  const names = new Set(o ? o.containers.map(c => c.name) : []);
  const recent = S.recent.filter(n => names.has(n)).slice(0, 5);
  if (recent.length) {
    h += `<div class="nav-recent"><div class="nav-cap">Recent</div>` + recent.map(n => {
      const c = o.containers.find(x => x.name === n);
      return `<a class="n sub ${cur === 'containers' && S.route[1] === n ? 'on' : ''}" href="#/containers/${enc(n)}">${stateIcon(c)}<span>${esc(n)}</span></a>`;
    }).join('') + '</div>';
  }
  setHTML($('#nav'), h);
  if (!o) return;
  $('#h-user-t').textContent = `${S.user}@${o.host.name}`;
  const al = $('#h-alarm');
  al.hidden = !o.alarms.length;
  al.innerHTML = `${icon('warn')}${o.alarms.length} alarm${o.alarms.length > 1 ? 's' : ''}`;
  renderTasks();
}

/* innerHTML that skips the DOM write when nothing changed (keeps hover, selection, scroll). */
function setHTML(el, html) {
  if (el._html === html) return false;
  el._html = html; el.innerHTML = html;
  return true;
}

function taskResult(t) {
  if (t.state === 'success') return `<span class="st ok">${icon('ok')}</span> Completed successfully`;
  if (t.state === 'error') return `<span class="st err">${icon('x')}</span> Failed - ${esc(t.error)}`;
  if (t.state === 'running') return `<span class="spin"></span> ${esc(t.progress || 'Running')}`;
  return 'Queued';
}
function taskRows(list) {
  return list.map(t => `<tr data-task="${t.id}"><td>${esc(t.name)}</td><td>${esc(t.target)}</td><td>${esc(t.user)}</td>
    <td>${fmt.date(t.queued)}</td><td>${fmt.date(t.started)}</td><td class="wrap">${taskResult(t)}</td><td>${fmt.date(t.finished)}</td></tr>`).join('');
}
const TASK_HEAD = '<thead><tr><th>Task</th><th>Target</th><th>Initiator</th><th>Queued</th><th>Started</th><th>Result</th><th>Completed</th></tr></thead>';
function renderTasks() {
  const list = S.ov.tasks.slice(0, 15);
  const active = S.ov.tasks.filter(t => t.state === 'running' || t.state === 'queued').length;
  $('#tasks-n').textContent = active ? `(${active} running)` : '';
  setHTML($('#tasks-body'), `<table class="grid">${TASK_HEAD}<tbody>${taskRows(list) || '<tr class="empty"><td colspan="7">No recent tasks</td></tr>'}</tbody></table>`);
}
$('#tasks-h').addEventListener('click', () => {
  const closed = $('#tasks').classList.toggle('closed');
  try { localStorage.setItem('drydock.tasks', closed ? '0' : '1'); } catch { /* ignore */ }
  window.dispatchEvent(new Event('resize'));
});
try { if (localStorage.getItem('drydock.tasks') === '0') $('#tasks').classList.add('closed'); } catch { /* ignore */ }
document.addEventListener('click', e => {
  const tr = e.target.closest('tr[data-task]');
  if (tr) taskDialog(+tr.dataset.task);
});

async function taskDialog(id) {
  let timer;
  const dlg = dialog({
    title: 'Task details', wide: true, body: '<div id="td">Loading…</div>',
    buttons: [{ label: 'Close' }], onClose: () => clearInterval(timer),
  });
  const load = async () => {
    try {
      const t = await api('/tasks/' + id);
      const box = $('#td', dlg);
      if (!box) return clearInterval(timer);
      const pre = $('pre', box), stick = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      box.innerHTML = `<dl class="kv" style="margin-bottom:10px"><dt>Task</dt><dd>${esc(t.name)}</dd><dt>Target</dt><dd>${esc(t.target)}</dd>
        <dt>Initiator</dt><dd>${esc(t.user)}</dd><dt>Started</dt><dd>${fmt.date(t.started)}</dd><dt>Result</dt><dd>${taskResult(t)}</dd></dl>
        <pre class="code dark" style="height:300px">${esc(t.log || '(no output)')}</pre>`;
      if (stick) $('pre', box).scrollTop = 1e9;
      if (t.state === 'success' || t.state === 'error') clearInterval(timer);
    } catch { clearInterval(timer); }
  };
  load(); timer = setInterval(load, 1500);
}

/* ---------------- router */
const VIEWS = {};
function setTitle(ic, text) { $('#title').innerHTML = `${icon(ic)}<span>${esc(text)}</span>`; document.title = `${text} - Drydock`; }
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) parts.push('host');
  if (S.view && S.view.destroy) S.view.destroy();
  closeMenu();
  const el = $('#view');
  el.innerHTML = ''; el._html = null;
  S.route = parts;
  S.view = (VIEWS[parts[0]] || VIEWS.host)(el, parts.slice(1));
  chrome();
  if (S.ov && S.view.update) S.view.update(S.ov);
}
window.addEventListener('hashchange', route);
const go = h => { if (location.hash === h) route(); else location.hash = h; };

/* ---------------- status helpers */
function stateIcon(c) {
  if (!c) return icon('box', 'off');
  if (c.state === 'running') return c.health === 'unhealthy' ? icon('warn', 'err') : icon('play', 'ok');
  if (c.state === 'paused') return icon('pause', 'warn');
  if (c.state === 'restarting') return icon('restart', 'err');
  return icon('stop', 'off');
}
function stateText(c) {
  const map = { running: 'Running', exited: 'Powered off', paused: 'Suspended', created: 'Created', restarting: 'Restarting', dead: 'Dead' };
  let s = map[c.state] || c.state;
  if (c.state === 'running' && c.health) s += c.health === 'healthy' ? ' (healthy)' : ` (${c.health})`;
  if (c.state === 'exited' && c.exit_code) s += ` (exit ${c.exit_code})`;
  return s;
}
function portLinks(c) {
  return c.ports.map(p => p.proto === 'tcp'
    ? `<a href="http://${location.hostname}:${p.host}" target="_blank" rel="noopener" title="${p.host} → ${p.container}/${p.proto}">${p.host}</a>`
    : `<span title="${p.host} → ${p.container}/${p.proto}">${p.host}/${p.proto}</span>`).join(', ');
}
function seriesColor(name) {
  if (!(name in S.colors)) {
    const used = new Set(Object.values(S.colors));
    let i = [0, 1, 2, 3, 4, 5, 6, 7].find(n => !used.has(n));
    if (i === undefined) i = Object.keys(S.colors).length % 8;
    S.colors[name] = i;
    try { localStorage.setItem('drydock.colors', JSON.stringify(S.colors)); } catch { /* ignore */ }
  }
  return `var(--s${S.colors[name] + 1})`;
}
function meter(label, used, cap, usedTxt, capTxt, freeTxt) {
  const p = cap > 0 ? Math.min(100, used / cap * 100) : 0;
  return `<div class="meter"><div class="m-top"><b>${label}</b><span>FREE: ${freeTxt}</span></div>
    <div class="m-bar"><i class="${p > 90 ? 'err' : p > 75 ? 'warn' : ''}" style="width:${p.toFixed(1)}%"></i></div>
    <div class="m-bot"><span>USED: ${usedTxt} (${p.toFixed(0)}%)</span><span>CAPACITY: ${capTxt}</span></div></div>`;
}
function sparkline(vals, w = 70, h = 16) {
  if (!vals || vals.length < 2) return '';
  const max = Math.max(1, ...vals), n = vals.length;
  const pts = vals.map((v, i) => `${(i / (n - 1) * w).toFixed(1)},${(h - 1 - v / max * (h - 2)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" style="stroke:var(--s1)" stroke-width="1.3"/></svg>`;
}

/* ---------------- grid */
class Grid {
  /* o: {cols:[{key,label,html(row),val(row),cls}], key(row), multi, sort:{key,dir}, search(row), empty, onOpen(row), onMenu(rows,ev), onSelect()} */
  constructor(el, o) {
    this.el = el; this.o = o; this.rows = []; this.sel = new Set(); this.sort = o.sort || null; this.filter = ''; this.quick = null;
    el.addEventListener('click', e => this.click(e));
    el.addEventListener('dblclick', e => { const r = this.rowOf(e); if (r && o.onOpen && !e.target.closest('a,input')) o.onOpen(r); });
    el.addEventListener('contextmenu', e => {
      const r = this.rowOf(e);
      if (!r || !o.onMenu) return;
      e.preventDefault();
      if (!this.sel.has(o.key(r))) { this.sel = new Set([o.key(r)]); this.draw(); this.changed(); }
      o.onMenu(this.selected(), e);
    });
  }
  rowOf(e) { const tr = e.target.closest('tr[data-k]'); return tr && this.rows.find(r => String(this.o.key(r)) === tr.dataset.k); }
  changed() { if (this.o.onSelect) this.o.onSelect(this.selected()); }
  click(e) {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      this.sort = this.sort && this.sort.key === k ? { key: k, dir: -this.sort.dir } : { key: k, dir: 1 };
      return this.draw();
    }
    if (e.target.matches('th input')) {
      const all = this.view();
      this.sel = e.target.checked ? new Set(all.map(this.o.key)) : new Set();
      this.draw(); return this.changed();
    }
    const r = this.rowOf(e);
    if (!r || e.target.closest('a')) return;
    const k = this.o.key(r);
    if (this.o.multi && (e.target.matches('input') || e.ctrlKey || e.metaKey)) { this.sel.has(k) ? this.sel.delete(k) : this.sel.add(k); } else this.sel = new Set([k]);
    this.draw(); this.changed();
  }
  set(rows) {
    this.rows = rows;
    const keys = new Set(rows.map(this.o.key));
    let dropped = false;
    for (const k of [...this.sel]) if (!keys.has(k)) { this.sel.delete(k); dropped = true; }
    this.draw();
    if (dropped) this.changed();
  }
  selected() { return this.rows.filter(r => this.sel.has(this.o.key(r))); }
  view() {
    let rows = this.rows;
    if (this.quick) rows = rows.filter(this.quick);
    const f = this.filter.trim().toLowerCase();
    if (f && this.o.search) rows = rows.filter(r => this.o.search(r).toLowerCase().includes(f));
    if (this.sort) {
      const col = this.o.cols.find(c => c.key === this.sort.key);
      if (col) {
        const val = col.val || (r => r[col.key]);
        rows = [...rows].sort((a, b) => {
          const x = val(a), y = val(b);
          const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
          return c * this.sort.dir;
        });
      }
    }
    return rows;
  }
  draw() {
    const o = this.o, rows = this.view();
    let h = '<div class="scroll"><table class="grid"><thead><tr>';
    if (o.multi) h += `<th class="chk"><input type="checkbox" aria-label="Select all" ${rows.length && rows.every(r => this.sel.has(o.key(r))) ? 'checked' : ''}></th>`;
    for (const c of o.cols) {
      const arr = this.sort && this.sort.key === c.key ? `<span class="arr">${this.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
      h += `<th ${c.nosort ? '' : `data-sort="${c.key}"`} class="${c.cls || ''}">${c.label}${arr}</th>`;
    }
    h += '</tr></thead><tbody>';
    for (const r of rows) {
      const k = o.key(r), on = this.sel.has(k);
      h += `<tr data-k="${esc(k)}" class="${on ? 'sel' : ''}">`;
      if (o.multi) h += `<td class="chk"><input type="checkbox" aria-label="Select row" ${on ? 'checked' : ''}></td>`;
      for (const c of o.cols) h += `<td class="${c.cls || ''}">${c.html ? c.html(r) : esc(r[c.key])}</td>`;
      h += '</tr>';
    }
    if (!rows.length) h += `<tr class="empty"><td colspan="${o.cols.length + (o.multi ? 1 : 0)}">${this.rows.length ? 'No items match the filter' : (o.empty || 'No items to display')}</td></tr>`;
    h += `</tbody></table></div><div class="grid-foot"><span>${this.sel.size ? this.sel.size + ' selected' : ''}</span><span>${rows.length} item${rows.length === 1 ? '' : 's'}</span></div>`;
    const sc = $('.scroll', this.el), top = sc ? sc.scrollTop : 0;
    if (setHTML(this.el, h) && top) $('.scroll', this.el).scrollTop = top;
  }
}
/* A grid host element that fills the remaining height. */
function gridHost(parent) {
  const el = document.createElement('div');
  el.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
  parent.append(el);
  return el;
}

/* ---------------- charts */
function niceMax(v, binary) {
  if (!(v > 0)) return 1;
  if (binary) {
    const unit = Math.pow(1024, Math.floor(Math.log(v) / Math.log(1024)));
    const m = v / unit;
    for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) if (m <= n) return n * unit;
  }
  const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
const chartObserver = new ResizeObserver(entries => { for (const e of entries) if (e.target._chart) drawChart(e.target); });
/* o: {series:[{name,color,t:[],v:[]}], from, to, step, fmt(v), max, floor, binary, height} */
function lineChart(el, o) {
  el.classList.add('chart');
  if (!el._chart) chartObserver.observe(el);
  el._chart = o;
  drawChart(el);
}
function drawChart(el) {
  const o = el._chart, W = Math.max(260, el.clientWidth), H = o.height || 170;
  const L = 64, R = 10, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
  const series = o.series.filter(s => s.t.length);
  if (!series.length || el.clientWidth === 0) {
    el.innerHTML = `<div class="chart-empty" style="height:${H}px">Collecting data — samples are taken every 10 seconds.</div>`;
    return;
  }
  let peak = 0;
  for (const s of series) for (const v of s.v) if (v != null && v > peak) peak = v;
  const ymax = o.max || Math.max(o.floor || 0, niceMax(peak * 1.05, o.binary));
  const x = t => L + (t - o.from) / (o.to - o.from) * pw;
  const y = v => T + ph - Math.min(1, v / ymax) * ph;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = ymax * i / 4, yy = y(v).toFixed(1);
    g += `<line class="gridl" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="axis" x="${L - 6}" y="${+yy + 3.5}" text-anchor="end">${esc(o.fmt(v))}</text>`;
  }
  const span = o.to - o.from, ticks = Math.max(2, Math.min(6, Math.floor(pw / 90)));
  for (let i = 0; i <= ticks; i++) {
    const t = o.from + span * i / ticks, d = new Date(t * 1000);
    const lab = span > 2 * 86400 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    g += `<text class="axis" x="${x(t).toFixed(1)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${lab}</text>`;
  }
  const gap = (o.step || 10) * 3.5;
  for (const s of series) {
    let dpath = '', open = false, segStart = 0, area = '';
    for (let i = 0; i < s.t.length; i++) {
      const v = s.v[i];
      if (v == null || (i > 0 && s.t[i] - s.t[i - 1] > gap)) {
        if (open && series.length === 1) area += `L${x(s.t[i - 1]).toFixed(1)},${T + ph}L${x(s.t[segStart]).toFixed(1)},${T + ph}Z`;
        open = false;
        if (v == null) continue;
      }
      const pt = `${x(s.t[i]).toFixed(1)},${y(v).toFixed(1)}`;
      if (!open) { segStart = i; area += 'M' + pt; }
      else area += 'L' + pt;
      dpath += (open ? 'L' : 'M') + pt;
      open = true;
    }
    if (open && series.length === 1) area += `L${x(s.t[s.t.length - 1]).toFixed(1)},${T + ph}L${x(s.t[segStart]).toFixed(1)},${T + ph}Z`;
    if (series.length === 1) g += `<path d="${area}" style="fill:${s.color};opacity:.1"/>`;
    g += `<path d="${dpath}" fill="none" style="stroke:${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  g += `<line class="cross" y1="${T}" y2="${T + ph}" x1="0" x2="0" visibility="hidden"/><rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/>`;
  const legend = series.length > 1 ? '<div class="legend">' + series.map(s => `<span><i class="key" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') + '</div>' : '';
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(o.label || 'chart')}">${g}</svg>${legend}<div class="chart-tip" hidden></div>`;
  const hit = $('.hit', el), cross = $('.cross', el), tip = $('.chart-tip', el);
  hit.addEventListener('mousemove', e => {
    const box = el.getBoundingClientRect(), px = (e.clientX - box.left) * (W / box.width);
    const t = o.from + (px - L) / pw * (o.to - o.from);
    let rows = '', tt = null;
    for (const s of series) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < s.t.length; i++) { const dd = Math.abs(s.t[i] - t); if (dd < bd && s.v[i] != null) { bd = dd; best = i; } }
      if (best < 0 || bd > gap) continue;
      if (tt == null) tt = s.t[best];
      rows += `<div class="r"><i class="key" style="background:${s.color}"></i>${esc(s.name)}<b>${esc(o.fmt(s.v[best]))}</b></div>`;
    }
    if (tt == null) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); return; }
    cross.setAttribute('x1', x(tt)); cross.setAttribute('x2', x(tt)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="t">${new Date(tt * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: span <= 3600 ? '2-digit' : undefined })}</div>${rows}`;
    tip.hidden = false;
    const left = e.clientX - box.left;
    tip.style.left = (left > box.width / 2 ? left - tip.offsetWidth - 12 : left + 12) + 'px';
    tip.style.top = '10px';
  });
  hit.addEventListener('mouseleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
}
const RANGES = [['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last day'], ['7d', 'Last week'], ['30d', 'Last month']];
const rangeSelect = cur => `<select data-range aria-label="Time range">${RANGES.map(r => `<option value="${r[0]}" ${r[0] === cur ? 'selected' : ''}>${r[1]}</option>`).join('')}</select>`;

/* ---------------- dialogs, menus */
function closeDialog() {
  const ov = $('#overlay');
  if (ov._onClose) { const f = ov._onClose; ov._onClose = null; f(); }
  ov.hidden = true; ov.innerHTML = '';
}
/* o: {title, body, wide, buttons:[{label, cls, fn(dlg)}], onClose}; fn may throw to show an error, or return false to stay open. */
function dialog(o) {
  closeDialog(); closeMenu();
  const ov = $('#overlay');
  ov.innerHTML = `<div class="dlg ${o.wide ? 'wide' : ''}" role="dialog" aria-modal="true"><h3>${icon(o.icon || 'box')}<span>${esc(o.title)}</span><button class="x" aria-label="Close">×</button></h3>
    <div class="d-body">${o.body}</div><div class="d-foot"><span class="d-err"></span>${(o.buttons || []).map((b, i) => `<button class="btn ${b.cls || ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
  ov.hidden = false; ov._onClose = o.onClose || null;
  const dlg = $('.dlg', ov);
  $('.x', dlg).onclick = closeDialog;
  $$('[data-b]', dlg).forEach(btn => btn.onclick = async () => {
    const b = o.buttons[+btn.dataset.b];
    if (!b.fn) return closeDialog();
    btn.disabled = true; $('.d-err', dlg).textContent = '';
    try { if (await b.fn(dlg) !== false) closeDialog(); } catch (e) { $('.d-err', dlg).textContent = e.message; }
    btn.disabled = false;
  });
  const first = $('input:not([type=checkbox]):not([type=radio]), textarea, select', dlg);
  if (first) first.focus();
  return dlg;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); if (!$('#overlay').hidden) closeDialog(); } });
function confirmDialog(title, html, label, fn, danger) {
  dialog({ title, body: html, icon: danger ? 'warn' : 'box', buttons: [{ label: 'Cancel' }, { label, cls: danger ? 'danger' : 'primary', fn }] });
}
/* Read named inputs of a dialog into an object. */
function formData(root) {
  const out = {};
  $$('[name]', root).forEach(i => { out[i.name] = i.type === 'checkbox' ? i.checked : i.type === 'radio' ? (i.checked ? i.value : out[i.name]) : i.value; });
  return out;
}

function closeMenu() { $('#menu').hidden = true; }
/* items: [{label, icon, cls, fn, dis}] | '-' | {head} */
function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.head ? `<div class="m-h">${esc(it.head)}</div>`
    : `<a data-i="${i}" class="${it.dis ? 'dis' : ''}">${icon(it.icon || 'box', it.cls || '')}${esc(it.label)}</a>`).join('');
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 6)) + 'px';
  $$('a', m).forEach(a => a.onclick = () => { closeMenu(); items[+a.dataset.i].fn(); });
}
function menuUnder(btn, items) { const r = btn.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, items); }
document.addEventListener('mousedown', e => { if (!e.target.closest('#menu')) closeMenu(); });

$('#h-user').onclick = e => { e.stopPropagation(); menuUnder(e.currentTarget, [
  { label: 'Log out', icon: 'user', fn: async () => { try { await api('/logout', { method: 'POST' }); } catch { /* already gone */ } showLogin(); } }]); };
$('#h-help').onclick = e => { e.stopPropagation(); menuUnder(e.currentTarget, [
  { label: 'About Drydock', icon: 'help', fn: () => dialog({ title: 'About', icon: 'help', buttons: [{ label: 'Close' }], body:
    `<h2 style="margin:0 0 4px;font-weight:300"><b>Drydock</b> Host Client</h2><p class="muted">Version ${esc(S.ov ? S.ov.host.version : '')} · Docker ${esc(S.ov ? S.ov.host.docker : '')}</p>
     <p>A single-host console for Docker containers: inventory, power operations, performance history and trends, an in-browser console, snapshots, and import/export of projects and portable bundles.</p>
     <p class="muted">Tips: right-click any row for its Actions menu · Ctrl-click to select several · double-click to open.</p>` }) }]); };
$('#h-search').addEventListener('input', e => {
  S.search = e.target.value;
  if (S.route[0] !== 'containers' || S.route[1]) go('#/containers');
  else if (S.view && S.view.search) S.view.search(S.search);
});

/* ---------------- boot */
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const s = await api('/session');
    if (s.user) start(s.user); else showLogin();
  } catch { showLogin(); }
});
