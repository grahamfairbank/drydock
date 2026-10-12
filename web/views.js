'use strict';
/* Drydock Host Client - views and actions. */

const tb = (act, ic, label, cls = '') => `<button class="tb" data-act="${act}">${icon(ic, cls)}${label}</button>`;
const SEP = '<span class="sep"></span>';
const cpuFmt = v => v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0) + '%';
const byName = n => (S.ov ? S.ov.containers.find(c => c.name === n) : null);
const cpath = c => '/containers/' + enc(c.name);
function wire(root, handlers) {
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled && handlers[b.dataset.act]) handlers[b.dataset.act](b, e);
  });
}
function every(ms, fn) { fn(); return setInterval(() => { if (!document.hidden) fn(); }, ms); }

/* =====================================================================
   Container actions
   ===================================================================== */
const Act = {
  power(rows, action) { rows.forEach(r => run(`${cpath(r)}/${action}`)); },
  stop(rows) {
    const live = rows.filter(r => r.state === 'running' || r.state === 'paused' || r.state === 'restarting');
    if (!live.length) return;
    confirmDialog('Power off', `<p>Power off ${live.length === 1 ? `<b>${esc(live[0].name)}</b>` : `<b>${live.length}</b> containers`}?</p>
      <p class="muted">The container is asked to shut down and is killed after 10 seconds.</p>`, 'Power off', () => Act.power(live, 'stop'));
  },
  remove(rows) {
    confirmDialog('Delete', `<p>Delete ${rows.length === 1 ? `container <b>${esc(rows[0].name)}</b>` : `<b>${rows.length}</b> containers`}? This cannot be undone.</p>
      <label class="check"><input type="checkbox" name="volumes"><span>Also delete anonymous volumes attached to the container</span></label>
      <p class="muted">Named volumes and bind-mounted directories are always kept.</p>`, 'Delete', dlg => {
      const v = formData(dlg).volumes ? '?volumes=1' : '';
      rows.forEach(r => run(cpath(r) + v, { method: 'DELETE' }));
      if (S.route[0] === 'containers' && S.route[1]) go('#/containers');
    }, true);
  },
  rename(row) {
    dialog({ title: `Rename ${row.name}`, icon: 'edit', body: `<div class="form"><label>New name</label><div><input type="text" name="name" value="${esc(row.name)}"></div></div>`,
      buttons: [{ label: 'Cancel' }, { label: 'Rename', cls: 'primary', fn: async dlg => {
        const name = formData(dlg).name.trim();
        const r = await api(`${cpath(row)}/rename`, { body: { name } });
        S.taskState[r.task] = 'queued'; setTimeout(poll, 400);
        if (S.route[1] === row.name) setTimeout(() => go('#/containers/' + enc(name)), 900);
      } }] });
  },
  async settings(row) {
    let det;
    try { det = await api(cpath(row)); } catch (e) { return toast('Cannot load settings', e.message, 'err'); }
    const hc = det.inspect.HostConfig, pol = (hc.RestartPolicy || {}).Name || 'no';
    const opt = (v, t) => `<option value="${v}" ${pol === v ? 'selected' : ''}>${t}</option>`;
    dialog({ title: `Edit settings - ${row.name}`, icon: 'gear', body: `<div class="form">
        <label>Autostart</label><div><select name="restart">${opt('no', 'Disabled (do not restart)')}${opt('unless-stopped', 'Start with host, unless powered off')}${opt('always', 'Always restart')}${opt('on-failure', 'Restart on failure')}</select>
          <div class="hint">What Docker does with this container after a crash or a host reboot.</div></div>
        <label>CPU limit</label><div><input type="number" name="cpus" min="0" step="0.25" placeholder="${hc.NanoCpus ? hc.NanoCpus / 1e9 : 'unlimited'}">
          <div class="hint">Number of host cores (${S.ov.host.ncpu} available). Leave blank to keep the current value.</div></div>
        <label>Memory limit (MB)</label><div><input type="number" name="memory" min="0" step="64" placeholder="${hc.Memory ? Math.round(hc.Memory / 1048576) : 'unlimited'}">
          <div class="hint">Leave blank to keep the current value. Limits apply immediately, without a restart.</div></div></div>`,
      buttons: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', fn: async dlg => {
        const f = formData(dlg);
        const r = await api(`${cpath(row)}/update`, { body: { restart: f.restart, cpus: f.cpus || null, memory: f.memory || null } });
        S.taskState[r.task] = 'queued'; setTimeout(poll, 400);
      } }] });
  },
  snapshot(row) {
    dialog({ title: `Take snapshot - ${row.name}`, icon: 'cam', body: `<div class="form">
        <label>Name</label><div><input type="text" name="name" value="Snapshot ${new Date().toLocaleString()}"></div>
        <label>Description</label><div><textarea name="comment" rows="3"></textarea></div></div>
        <p class="muted">A snapshot captures the container's filesystem as an image (the container is paused for a moment). Data in volumes and bind mounts is not part of a snapshot.</p>`,
      buttons: [{ label: 'Cancel' }, { label: 'Take snapshot', cls: 'primary', fn: dlg => { run(`${cpath(row)}/snapshot`, { body: formData(dlg) }); } }] });
  },
  exportDlg(rows) {
    dialog({ title: `Export ${rows.length === 1 ? rows[0].name : rows.length + ' containers'}`, icon: 'down', body: `
        <p>Creates a portable bundle (<span class="mono">.drydock.tar.gz</span>) holding the container configuration, its image and a reference compose file. Import it on any Drydock host to re-create the container.</p>
        <label class="check"><input type="checkbox" name="volumes" checked><span>Include the data stored in named volumes</span></label>
        <label class="check"><input type="checkbox" name="commit"><span>Capture the current filesystem instead of the original image<br><small class="muted">Use this when files were changed inside the container after it was created.</small></span></label>
        <label class="check"><input type="checkbox" name="source"><span>Include the project source directory<br><small class="muted">Only for containers deployed from a compose project. May contain secrets such as <span class="mono">.env</span> files.</small></span></label>
        <p class="muted">Bind-mounted host directories are recorded but their contents are not exported.</p>`,
      buttons: [{ label: 'Cancel' }, { label: 'Export', cls: 'primary', fn: async dlg => {
        const f = formData(dlg);
        const r = await run('/export', { body: { ids: rows.map(r => r.id), ...f } });
        if (r) toast('Export started', 'The bundle will appear under Storage › Exports when the task completes.');
      } }] });
  },
};

function containerMenu(rows) {
  const one = rows.length === 1 ? rows[0] : null;
  const any = st => rows.some(r => st.includes(r.state));
  const self = rows.some(r => r.self);
  return [
    { head: one ? one.name : `${rows.length} containers` },
    { label: 'Power on', icon: 'play', cls: 'ok', dis: !any(['exited', 'created', 'dead']), fn: () => Act.power(rows.filter(r => r.state !== 'running' && r.state !== 'paused'), 'start') },
    { label: 'Power off', icon: 'stop', cls: 'err', dis: !any(['running', 'paused', 'restarting']) || self, fn: () => Act.stop(rows) },
    { label: 'Restart', icon: 'restart', dis: !any(['running']), fn: () => Act.power(rows.filter(r => r.state === 'running'), 'restart') },
    any(['paused']) ? { label: 'Resume', icon: 'play', cls: 'ok', fn: () => Act.power(rows.filter(r => r.state === 'paused'), 'unpause') }
      : { label: 'Suspend', icon: 'pause', cls: 'warn', dis: !any(['running']) || self, fn: () => Act.power(rows.filter(r => r.state === 'running'), 'pause') },
    { label: 'Kill', icon: 'bolt', cls: 'err', dis: !any(['running', 'paused', 'restarting']) || self, fn: () => Act.power(rows.filter(r => r.state !== 'exited'), 'kill') },
    '-',
    { label: 'Open console', icon: 'term', dis: !one || one.state !== 'running', fn: () => go(`#/containers/${enc(one.name)}/console`) },
    { label: 'View logs', icon: 'file', dis: !one, fn: () => go(`#/containers/${enc(one.name)}/logs`) },
    '-',
    { label: 'Take snapshot…', icon: 'cam', dis: !one, fn: () => Act.snapshot(one) },
    { label: 'Export…', icon: 'down', fn: () => Act.exportDlg(rows) },
    { label: 'Edit settings…', icon: 'gear', dis: !one, fn: () => Act.settings(one) },
    { label: 'Rename…', icon: 'edit', dis: !one || self, fn: () => Act.rename(one) },
    '-',
    { label: 'Delete…', icon: 'trash', cls: 'err', dis: self, fn: () => Act.remove(rows) },
  ];
}

/* =====================================================================
   Host
   ===================================================================== */
VIEWS.host = el => {
  setTitle('host', S.ov ? S.ov.host.name : 'Host');
  el.innerHTML = `<div class="toolbar">${tb('create', 'plus', 'Create / Register container')}${SEP}${tb('monitor', 'chart', 'Monitor')}${tb('refresh', 'refresh', 'Refresh')}</div>
    <div class="scroll pad"><div id="h-top"></div><div class="panels">
      <div class="panel wide"><h3>Performance summary<span class="sp"></span>last hour</h3><div class="body"><div class="charts"><div><div class="muted">Host CPU</div><div id="h-c1"></div></div><div><div class="muted">Host memory</div><div id="h-c2"></div></div></div></div></div>
      <div class="panel" id="h-top-cpu"></div><div class="panel" id="h-inv"></div>
      <div class="panel" id="h-hw"></div><div class="panel" id="h-cfg"></div>
    </div></div>`;
  const charts = async () => {
    try {
      const m = await api('/metrics?target=_host&range=1h');
      const base = { from: m.from, to: m.to, step: m.step, height: 150 };
      lineChart($('#h-c1', el), { ...base, label: 'Host CPU', max: 100, fmt: v => v.toFixed(0) + '%', series: [{ name: 'CPU', color: 'var(--s1)', t: m.t, v: m.cpu }] });
      lineChart($('#h-c2', el), { ...base, label: 'Host memory', max: m.mem_total[0], binary: true, fmt: v => fmt.bytes(v, 1), series: [{ name: 'Memory used', color: 'var(--s1)', t: m.t, v: m.mem }] });
    } catch { /* retried on the next interval */ }
  };
  const timer = every(30000, charts);
  wire(el, { create: () => openWizard(), monitor: () => go('#/monitor'), refresh: () => { poll(); charts(); } });
  return {
    destroy: () => clearInterval(timer),
    update(o) {
      const h = o.host, s = h.stats || {}, run = o.containers.filter(c => c.state === 'running').length;
      setTitle('host', h.name);
      const banners = o.alarms.map(a => `<div class="banner ${a.level === 'error' ? 'error' : ''}">${icon('warn', a.level === 'error' ? 'err' : 'warn')}<span>${a.target ? `Container <a href="#/containers/${enc(a.target)}">${esc(a.target)}</a> ` : ''}${esc(a.text)}</span></div>`).join('');
      const cpuCap = h.ncpu, cpuUsed = (s.cpu || 0) / 100 * cpuCap;
      setHTML($('#h-top', el), `${banners}<div class="summary-top"><div class="summary-id"><div class="big-icon">${icon('host')}</div><div style="min-width:0">
          <h2>${esc(h.name)}</h2><dl class="kv"><dt>Version:</dt><dd>Docker Engine ${esc(h.docker)}</dd>
          <dt>State:</dt><dd>${o.alarms.length ? `<span class="warn">${icon('warn')}</span> ${o.alarms.length} alarm${o.alarms.length > 1 ? 's' : ''}` : `<span class="ok">${icon('ok')}</span> Normal`} (connected to the local Docker engine)</dd>
          <dt>Uptime:</dt><dd>${fmt.dur(h.uptime)}</dd><dt>Load average:</dt><dd>${(s.load1 || 0).toFixed(2)}</dd></dl></div></div>
        <div class="meters">${meter('CPU', cpuUsed, cpuCap, cpuUsed.toFixed(2) + ' cores', cpuCap + ' cores', (cpuCap - cpuUsed).toFixed(2) + ' cores')}
          ${meter('MEMORY', s.mem, s.mem_total, fmt.bytes(s.mem), fmt.bytes(s.mem_total), fmt.bytes(s.mem_total - s.mem))}
          ${meter('STORAGE', s.disk, s.disk_total, fmt.bytes(s.disk), fmt.bytes(s.disk_total), fmt.bytes(s.disk_total - s.disk))}</div></div>`);
      const top = o.containers.filter(c => c.stats).sort((a, b) => b.stats.cpu - a.stats.cpu).slice(0, 6);
      setHTML($('#h-top-cpu', el), `<h3>${icon('chart')}Top consumers</h3><div class="body flush"><table class="grid"><thead><tr><th>Container</th><th>Host CPU</th><th>Host memory</th></tr></thead><tbody>${top.map(c =>
        `<tr><td>${stateIcon(c)} <a href="#/containers/${enc(c.name)}">${esc(c.name)}</a></td>
         <td><span class="minibar"><i style="width:${Math.min(100, c.stats.cpu / h.ncpu).toFixed(1)}%"></i></span>${fmt.pct(c.stats.cpu)}</td>
         <td><span class="minibar"><i style="width:${Math.min(100, c.stats.mem / h.mem_total * 100).toFixed(1)}%"></i></span>${fmt.bytes(c.stats.mem)}</td></tr>`).join('') || '<tr class="empty"><td colspan="3">No running containers</td></tr>'}</tbody></table></div>`);
      setHTML($('#h-inv', el), `<h3>${icon('box')}Inventory</h3><div class="body"><dl class="kv">
        <dt>Containers</dt><dd><a href="#/containers">${o.containers.length}</a> (${run} running, ${o.containers.length - run} powered off or suspended)</dd>
        <dt>Images</dt><dd><a href="#/storage/images">${o.counts.images}</a></dd><dt>Volumes</dt><dd><a href="#/storage/volumes">${o.counts.volumes}</a></dd>
        <dt>Networks</dt><dd><a href="#/networking">${o.counts.networks}</a></dd>
        <dt>Network traffic</dt><dd>↓ ${fmt.rate(s.rx)} &nbsp; ↑ ${fmt.rate(s.tx)}</dd></dl></div>`);
      setHTML($('#h-hw', el), `<h3>${icon('host')}Hardware</h3><div class="body"><dl class="kv"><dt>CPU</dt><dd>${h.ncpu} CPUs × ${esc(h.cpu_model || h.arch)}</dd>
        <dt>Memory</dt><dd>${fmt.bytes(h.mem_total, 2)}</dd><dt>Architecture</dt><dd>${esc(h.arch)}</dd><dt>Storage</dt><dd>${fmt.bytes(s.disk_total)} total, ${fmt.bytes(s.disk_total - s.disk)} free</dd></dl></div>`);
      setHTML($('#h-cfg', el), `<h3>${icon('gear')}Configuration</h3><div class="body"><dl class="kv"><dt>Operating system</dt><dd>${esc(h.os)}</dd><dt>Kernel</dt><dd>${esc(h.kernel)}</dd>
        <dt>Docker Engine</dt><dd>${esc(h.docker)} (storage driver ${esc(h.driver)}, cgroup v${esc(h.cgroup)})</dd><dt>Docker root</dt><dd class="mono">${esc(h.root_dir)}</dd>
        <dt>Projects root</dt><dd class="mono">${esc(h.projects_root)}</dd><dt>Drydock</dt><dd>${esc(h.version)}</dd></dl></div>`);
    },
  };
};

/* =====================================================================
   Monitor
   ===================================================================== */
VIEWS.monitor = (el, args) => {
  const tab = args[0] || 'performance';
  setTitle('chart', 'Monitor');
  const tabs = [['performance', 'Performance'], ['trends', 'Trends'], ['events', 'Events'], ['tasks', 'Tasks']];
  el.innerHTML = `<div class="tabs">${tabs.map(t => `<a href="#/monitor/${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}</a>`).join('')}</div><div id="mbody" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`;
  const body = $('#mbody', el);
  let timer, view = {};
  if (tab === 'performance') {
    let range = '1h';
    body.innerHTML = `<div class="toolbar">${tb('refresh', 'refresh', 'Refresh')}<span class="sp"></span>${rangeSelect(range)}</div><div class="scroll pad"><div class="charts">
      ${['Host CPU', 'Host memory', 'Host network', 'Host storage used', 'CPU by container (busiest six, % of one core)', 'Memory by container (largest six)'].map((t, i) => `<div class="panel"><h3>${t}</h3><div class="body"><div id="mc${i}"></div></div></div>`).join('')}</div></div>`;
    const load = async () => {
      try {
        const [m, tc, tm] = await Promise.all([api(`/metrics?target=_host&range=${range}`), api(`/metrics?top=cpu&range=${range}`), api(`/metrics?top=mem&range=${range}`)]);
        const base = { from: m.from, to: m.to, step: m.step, height: 180 };
        const one = (i, name, v, extra) => lineChart($('#mc' + i, body), { ...base, label: name, series: [{ name, color: 'var(--s1)', t: m.t, v }], ...extra });
        one(0, 'CPU', m.cpu, { max: 100, fmt: v => v.toFixed(0) + '%' });
        one(1, 'Memory used', m.mem, { max: m.mem_total[0], binary: true, fmt: v => fmt.bytes(v) });
        lineChart($('#mc2', body), { ...base, label: 'Host network', binary: true, fmt: fmt.rate, series: [{ name: 'Received', color: 'var(--s1)', t: m.t, v: m.rx }, { name: 'Transmitted', color: 'var(--s2)', t: m.t, v: m.tx }] });
        one(3, 'Storage used', m.disk, { max: m.disk_total[0], binary: true, fmt: v => fmt.bytes(v) });
        const multi = (i, d, extra) => lineChart($('#mc' + i, body), { ...base, from: d.from, to: d.to, step: d.step, series: d.series.map(s => ({ name: s.name, color: seriesColor(s.name), t: d.t, v: s.v })), ...extra });
        multi(4, tc, { label: 'CPU by container', floor: 1, fmt: cpuFmt });
        multi(5, tm, { label: 'Memory by container', binary: true, fmt: v => fmt.bytes(v) });
      } catch { /* retried */ }
    };
    timer = every(30000, load);
    $('[data-range]', body).onchange = e => { range = e.target.value; load(); };
    wire(body, { refresh: load });
  } else if (tab === 'trends') {
    body.innerHTML = '<div class="scroll pad" id="tr">Loading…</div>';
    const load = async () => {
      let t;
      try { t = await api('/trends'); } catch { return; }
      const h = t.host, box = $('#tr', body);
      let hostTxt = '<div class="banner info">' + icon('chart') + '<span>Trends appear once Drydock has collected a few hours of samples.</span></div>';
      if (h.span) {
        const grow = h.disk_per_day;
        hostTxt = `<div class="panels" style="margin-bottom:12px"><div class="panel"><h3>${icon('db')}Storage forecast</h3><div class="body"><dl class="kv">
          <dt>Change</dt><dd>${h.span < 6 * 3600 ? '<span class="muted">Needs about 6 hours of history</span>' : Math.abs(grow) < 1048576 ? 'Stable' : (grow > 0 ? '+' : '−') + fmt.bytes(Math.abs(grow)) + ' per day'}</dd>
          <dt>Free space</dt><dd>${fmt.bytes(h.disk_free)}</dd>
          <dt>Projection</dt><dd>${h.days_to_full ? `<span class="${h.days_to_full < 30 ? 'err' : h.days_to_full < 90 ? 'warn' : ''}">Full in about ${h.days_to_full > 730 ? 'more than 2 years' : Math.round(h.days_to_full) + ' days'}</span> at the current rate` : h.span < 6 * 3600 ? '<span class="muted">Collecting data</span>' : 'No sustained growth detected'}</dd>
          <dt>Based on</dt><dd>${fmt.dur(h.span)} of history</dd></dl></div></div>
          <div class="panel"><h3>${icon('host')}Host load</h3><div class="body"><dl class="kv"><dt>CPU average</dt><dd>${fmt.pct(h.cpu_avg)}</dd><dt>CPU peak</dt><dd>${fmt.pct(h.cpu_peak)}</dd>
          <dt>Memory average</dt><dd>${fmt.bytes(h.mem_avg)}</dd><dt>Memory peak</dt><dd>${fmt.bytes(h.mem_peak)}</dd></dl></div></div></div>`;
      }
      const delta = (now, day) => {
        if (day < 0.5 && now < 0.5) return '<span class="muted">idle</span>';
        const d = day > 0 ? (now - day) / day * 100 : 0;
        return Math.abs(d) < 15 ? '<span class="muted">steady</span>' : d > 0 ? `<span class="warn">▲ ${d.toFixed(0)}%</span>` : `<span class="ok">▼ ${Math.abs(d).toFixed(0)}%</span>`;
      };
      const rows = t.containers.sort((a, b) => b.cpu_day - a.cpu_day).map(c => `<tr><td><a href="#/containers/${enc(c.name)}/monitor">${esc(c.name)}</a></td>
        <td class="num">${fmt.pct(c.cpu_hour)}</td><td class="num">${fmt.pct(c.cpu_day)}</td><td class="num">${fmt.pct(c.cpu_peak)}</td><td>${delta(c.cpu_hour, c.cpu_day)}</td>
        <td class="num">${fmt.bytes(c.mem_hour)}</td><td class="num">${fmt.bytes(c.mem_day)}</td><td class="num">${fmt.bytes(c.mem_peak)}</td>
        <td>${c.mem_growing ? `<span class="warn">${icon('warn')} growing ${fmt.bytes(c.mem_per_hour)}/h</span>` : '<span class="muted">stable</span>'}</td><td class="muted">${fmt.dur(c.span)}</td></tr>`).join('');
      box.innerHTML = `${hostTxt}<div class="panel"><h3>${icon('box')}Container trends<span class="sp"></span><span class="muted" style="font-weight:400">last hour compared with the last day</span></h3><div class="body flush"><table class="grid">
        <thead><tr><th>Container</th><th>CPU, last hour</th><th>CPU, day avg</th><th>CPU, day peak</th><th>CPU trend</th><th>Memory, last hour</th><th>Memory, day avg</th><th>Memory, day peak</th><th>Memory trend</th><th>History</th></tr></thead>
        <tbody>${rows || '<tr class="empty"><td colspan="10">Collecting data — check back in a few minutes</td></tr>'}</tbody></table></div></div>`;
    };
    timer = every(30000, load);
  } else if (tab === 'events') {
    body.innerHTML = `<div class="toolbar">${tb('refresh', 'refresh', 'Refresh')}</div>`;
    const grid = new Grid(gridHost(body), { key: r => r.i, empty: 'No events recorded yet', search: r => r.name + r.action + r.type, cols: [
      { key: 'ts', label: 'Time', html: r => fmt.date(r.ts) }, { key: 'type', label: 'Type' }, { key: 'action', label: 'Event' },
      { key: 'name', label: 'Target', html: r => r.type === 'container' && byName(r.name) ? `<a href="#/containers/${enc(r.name)}">${esc(r.name)}</a>` : esc(r.name) },
      { key: 'detail', label: 'Details' }] });
    const load = async () => { try { grid.set((await api('/events?limit=500')).map((e, i) => ({ ...e, i: e.ts + ':' + i }))); } catch { /* retried */ } };
    timer = every(10000, load);
    wire(body, { refresh: load });
  } else {
    body.innerHTML = '<div class="scroll" id="tk"></div>';
    view.update = o => setHTML($('#tk', body), `<table class="grid">${TASK_HEAD}<tbody>${taskRows(o.tasks) || '<tr class="empty"><td colspan="7">No tasks yet</td></tr>'}</tbody></table>`);
  }
  return { ...view, destroy: () => clearInterval(timer) };
};

/* =====================================================================
   Containers: list
   ===================================================================== */
VIEWS.containers = (el, args) => (args.length ? containerDetail(el, args[0], args[1] || 'summary') : containerList(el));

function containerList(el) {
  setTitle('box', 'Containers');
  el.innerHTML = `<div class="toolbar">${tb('create', 'plus', 'Create / Register container')}${SEP}${tb('console', 'term', 'Console')}${SEP}
    ${tb('start', 'play', 'Power on', 'ok')}${tb('stop', 'stop', 'Power off', 'err')}${tb('pause', 'pause', 'Suspend', 'warn')}${tb('restart', 'restart', 'Restart')}${SEP}
    ${tb('refresh', 'refresh', 'Refresh')}${SEP}${tb('actions', 'gear', 'Actions')}<span class="sp"></span>
    <select id="quick" aria-label="Quick filter"><option value="">All containers</option><option value="running">Running</option><option value="off">Powered off</option><option value="alarm">With alarms</option></select>
    <input type="search" id="cfilter" placeholder="Search" aria-label="Search" value="${esc(S.search || '')}"></div>`;
  const memTotal = () => (S.ov ? S.ov.host.mem_total : 1);
  const grid = new Grid(gridHost(el), {
    multi: true, key: r => r.name, sort: { key: 'name', dir: 1 }, empty: 'No containers on this host. Use Create / Register container to add one.',
    search: r => `${r.name} ${r.image} ${r.project} ${r.status}`,
    onOpen: r => go('#/containers/' + enc(r.name)),
    onMenu: (rows, e) => showMenu(e.clientX, e.clientY, containerMenu(rows)),
    onSelect: () => buttons(),
    cols: [
      { key: 'name', label: 'Container', html: r => `<span class="st">${stateIcon(r)}<a href="#/containers/${enc(r.name)}">${esc(r.name)}</a></span>${r.self ? ' <span class="chip">this console</span>' : ''}` },
      { key: 'state', label: 'Status', val: r => stateText(r), html: r => `<span title="${esc(r.status)}">${esc(stateText(r))}</span>` },
      { key: 'project', label: 'Project', html: r => (r.project ? esc(r.project) : '<span class="muted">-</span>') },
      { key: 'image', label: 'Image', html: r => `<span title="${esc(r.image)}">${esc(r.image.startsWith('sha256:') ? r.image.slice(7, 19) : r.image)}</span>` },
      { key: 'cpu', label: 'Host CPU', val: r => (r.stats ? r.stats.cpu : -1), html: r => (r.stats ? `<span class="num" style="display:inline-block;min-width:44px">${fmt.pct(r.stats.cpu)}</span>${sparkline(r.spark)}` : '') },
      { key: 'mem', label: 'Host memory', val: r => (r.stats ? r.stats.mem : -1), html: r => (r.stats ? `<span class="minibar"><i style="width:${Math.min(100, r.stats.mem / memTotal() * 100).toFixed(1)}%"></i></span>${fmt.bytes(r.stats.mem)}` : '') },
      { key: 'ports', label: 'Ports', nosort: true, html: r => portLinks(r) || (r.network_mode === 'host' ? '<span class="muted">host network</span>' : '') },
      { key: 'status', label: 'Uptime', html: r => esc(r.state === 'running' ? r.status.replace(/^Up /, '').replace(/\s*\(.*\)$/, '') : r.status) },
    ],
  });
  grid.filter = S.search || '';
  const alarmed = () => new Set((S.ov ? S.ov.alarms : []).map(a => a.target));
  const buttons = () => {
    const sel = grid.selected(), any = st => sel.some(r => st.includes(r.state)), self = sel.some(r => r.self);
    const set = (act, on) => { const b = $(`[data-act=${act}]`, el); if (b) b.disabled = !on; };
    set('console', sel.length === 1 && sel[0].state === 'running');
    set('start', any(['exited', 'created', 'dead', 'paused']));
    set('stop', any(['running', 'paused', 'restarting']) && !self);
    set('pause', any(['running']) && !self);
    set('restart', any(['running']));
    set('actions', sel.length > 0);
  };
  wire(el, {
    create: () => openWizard(),
    console: () => go(`#/containers/${enc(grid.selected()[0].name)}/console`),
    start: () => { const s = grid.selected(); Act.power(s.filter(r => r.state === 'paused'), 'unpause'); Act.power(s.filter(r => !['running', 'paused'].includes(r.state)), 'start'); },
    stop: () => Act.stop(grid.selected()),
    pause: () => Act.power(grid.selected().filter(r => r.state === 'running'), 'pause'),
    restart: () => Act.power(grid.selected().filter(r => r.state === 'running'), 'restart'),
    refresh: poll,
    actions: b => menuUnder(b, containerMenu(grid.selected())),
  });
  $('#cfilter', el).oninput = e => { S.search = grid.filter = e.target.value; $('#h-search').value = S.search; grid.draw(); };
  $('#quick', el).onchange = e => {
    const v = e.target.value;
    grid.quick = !v ? null : v === 'running' ? r => r.state === 'running' : v === 'off' ? r => r.state !== 'running' : r => alarmed().has(r.name);
    grid.draw();
  };
  buttons();
  return {
    update(o) { grid.set(o.containers); buttons(); },
    search(v) { grid.filter = v; $('#cfilter', el).value = v; grid.draw(); },
  };
}

/* =====================================================================
   Containers: detail
   ===================================================================== */
function containerDetail(el, name, tab) {
  setTitle('box', name);
  S.recent = [name, ...S.recent.filter(n => n !== name)].slice(0, 8);
  try { localStorage.setItem('drydock.recent', JSON.stringify(S.recent)); } catch { /* ignore */ }
  const tabs = [['summary', 'Summary'], ['monitor', 'Monitor'], ['logs', 'Logs'], ['console', 'Console'], ['processes', 'Processes'], ['snapshots', 'Snapshots'], ['events', 'Events']];
  el.innerHTML = `<div class="toolbar">${tb('console', 'term', 'Console')}${SEP}${tb('start', 'play', 'Power on', 'ok')}${tb('stop', 'stop', 'Power off', 'err')}${tb('pause', 'pause', 'Suspend', 'warn')}${tb('restart', 'restart', 'Restart')}${SEP}
    ${tb('edit', 'edit', 'Edit')}${tb('refresh', 'refresh', 'Refresh')}${SEP}${tb('actions', 'gear', 'Actions')}</div>
    <div class="tabs">${tabs.map(t => `<a href="#/containers/${enc(name)}/${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}</a>`).join('')}</div>
    <div id="cbody" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`;
  const body = $('#cbody', el);
  const row = () => byName(name);
  const sub = (TABS[tab] || TABS.summary)(body, name);
  const buttons = () => {
    const r = row(), st = r ? r.state : '', set = (act, on) => { $(`[data-act=${act}]`, el).disabled = !on; };
    set('console', st === 'running'); set('start', r && !['running', 'restarting'].includes(st));
    set('stop', ['running', 'paused', 'restarting'].includes(st) && !r.self); set('pause', st === 'running' && !r.self);
    set('restart', st === 'running'); set('edit', !!r); set('actions', !!r);
    $('[data-act=pause]', el).lastChild.textContent = st === 'paused' ? 'Resume' : 'Suspend';
  };
  wire(el.firstElementChild, {
    console: () => go(`#/containers/${enc(name)}/console`),
    start: () => Act.power([row()], row().state === 'paused' ? 'unpause' : 'start'),
    stop: () => Act.stop([row()]),
    pause: () => Act.power([row()], 'pause'),
    restart: () => Act.power([row()], 'restart'),
    edit: () => Act.settings(row()),
    refresh: () => { poll(); if (sub.refresh) sub.refresh(); },
    actions: b => menuUnder(b, containerMenu([row()])),
  });
  buttons();
  return {
    update(o) { buttons(); if (sub.update) sub.update(o); },
    refresh() { if (sub.refresh) sub.refresh(); },
    destroy() { if (sub.destroy) sub.destroy(); },
  };
}

const TABS = {};
const SECRET_RE = /(pass|secret|token|key|credential|auth)/i;

TABS.summary = (body, name) => {
  body.innerHTML = `<div class="scroll pad"><div id="s-top"></div><div class="panels">
    <div class="panel wide"><h3>Performance summary<span class="sp"></span>last hour</h3><div class="body"><div class="charts"><div><div class="muted">CPU (% of one core)</div><div id="s-c1"></div></div><div><div class="muted">Memory</div><div id="s-c2"></div></div></div></div></div>
    <div class="panel" id="s-gen"></div><div class="panel" id="s-res"></div><div class="panel" id="s-net"></div><div class="panel" id="s-env"></div>
    <div class="panel" id="s-note"><h3>${icon('edit')}Notes<span class="sp"></span><a data-act="savenote">Save</a></h3><div class="body"><textarea rows="4" id="note" placeholder="Notes about this container (kept by Drydock)"></textarea></div></div>
    <div class="panel" id="s-lab"></div></div></div>`;
  let det = null, thumb = '', missing = false, noteLoaded = false;
  const reveal = new Set();
  const draw = () => {
    const c = byName(name), o = S.ov;
    if (missing || (o && !c && !det)) {
      return setHTML($('#s-top', body), `<div class="banner error">${icon('warn', 'err')}<span>Container <b>${esc(name)}</b> no longer exists on this host. <a href="#/containers">Back to containers</a></span></div>`);
    }
    if (!det || !o) return;
    const i = det.inspect, cfg = i.Config, hc = i.HostConfig, st = c ? c.stats : null, h = o.host;
    const alarms = o.alarms.filter(a => a.target === name).map(a => `<div class="banner ${a.level === 'error' ? 'error' : ''}">${icon('warn', a.level === 'error' ? 'err' : 'warn')}<span>This container ${esc(a.text)}</span></div>`).join('');
    const selfNote = det.self ? `<div class="banner info">${icon('help')}<span>This container runs the Drydock console you are using. Power off, suspend and delete are disabled for it.</span></div>` : '';
    const cpuCap = hc.NanoCpus ? hc.NanoCpus / 1e9 : h.ncpu, cpuUsed = st ? st.cpu / 100 : 0;
    const memCap = st && st.mem_limit ? st.mem_limit : (hc.Memory || h.mem_total);
    const running = c && c.state === 'running';
    setHTML($('#s-top', body), `${selfNote}${alarms}<div class="summary-top"><div class="summary-id">
        <div class="thumb ${running ? '' : 'offl'}" data-act="thumb" data-cap="${running ? 'Open console' : 'Powered off'}" title="Latest log output">${esc(thumb)}</div>
        <div style="min-width:0"><h2>${esc(name)}</h2><dl class="kv">
          <dt>State</dt><dd>${c ? `<span class="st">${stateIcon(c)}${esc(stateText(c))}</span>` : '-'}</dd>
          <dt>Image</dt><dd>${esc(cfg.Image)}</dd>
          <dt>Created</dt><dd>${esc(new Date(i.Created).toLocaleString())}</dd>
          <dt>${running ? 'Started' : 'Stopped'}</dt><dd>${esc(new Date(running ? i.State.StartedAt : i.State.FinishedAt).toLocaleString())}${i.RestartCount ? ` · restarted ${i.RestartCount}×` : ''}</dd>
          <dt>Ports</dt><dd>${c && c.ports.length ? c.ports.map(p => `${p.proto === 'tcp' ? `<a href="http://${location.hostname}:${p.host}" target="_blank" rel="noopener">${p.host}</a>` : p.host} → ${p.container}/${p.proto}`).join(', ') : (hc.NetworkMode === 'host' ? 'host network' : 'none published')}</dd>
          ${cfg.Labels && cfg.Labels['com.docker.compose.project'] ? `<dt>Project</dt><dd>${esc(cfg.Labels['com.docker.compose.project'])} <span class="muted">(${esc(cfg.Labels['com.docker.compose.project.working_dir'] || '')})</span></dd>` : ''}
        </dl></div></div>
      <div class="meters">${meter('CPU', cpuUsed, cpuCap, cpuUsed.toFixed(2) + ' cores', cpuCap + ' cores', Math.max(0, cpuCap - cpuUsed).toFixed(2) + ' cores')}
        ${meter('MEMORY', st ? st.mem : 0, memCap, fmt.bytes(st ? st.mem : 0), fmt.bytes(memCap), fmt.bytes(Math.max(0, memCap - (st ? st.mem : 0))))}
        <div class="meter"><div class="m-top"><b>NETWORK</b><span>${st ? `total ↓ ${fmt.bytes(st.rx_total)} ↑ ${fmt.bytes(st.tx_total)}` : ''}</span></div>
          <div class="m-bot" style="font-size:12px"><span>↓ ${st ? fmt.rate(st.rx) : '-'}</span><span>↑ ${st ? fmt.rate(st.tx) : '-'}</span><span>${st ? st.pids + ' processes' : ''}</span></div></div></div></div>`);
    const cmd = [...(cfg.Entrypoint || []), ...(cfg.Cmd || [])].join(' ');
    const health = i.State.Health ? i.State.Health.Status : 'not configured';
    setHTML($('#s-gen', body), `<h3>${icon('box')}General information</h3><div class="body"><dl class="kv">
      <dt>Container ID</dt><dd class="mono">${esc(i.Id.slice(0, 12))}</dd><dt>Host name</dt><dd>${esc(cfg.Hostname)}</dd>
      <dt>Command</dt><dd class="mono">${esc(cmd) || '-'}</dd><dt>Working directory</dt><dd class="mono">${esc(cfg.WorkingDir || '/')}</dd>
      <dt>User</dt><dd>${esc(cfg.User || 'root')}</dd><dt>Health check</dt><dd>${esc(health)}</dd>
      <dt>Autostart</dt><dd>${esc(({ no: 'Disabled', always: 'Always restart', 'unless-stopped': 'Start with host, unless powered off', 'on-failure': 'Restart on failure' })[(hc.RestartPolicy || {}).Name || 'no'])}</dd></dl></div>`);
    const mounts = (i.Mounts || []).map(m => `<tr><td>${esc(m.Type)}</td><td class="wrap mono">${esc(m.Type === 'volume' ? m.Name : m.Source)}</td><td class="mono">${esc(m.Destination)}</td><td>${m.RW ? 'read/write' : 'read-only'}</td></tr>`).join('');
    setHTML($('#s-res', body), `<h3>${icon('db')}Resources and storage</h3><div class="body"><dl class="kv"><dt>CPU limit</dt><dd>${hc.NanoCpus ? hc.NanoCpus / 1e9 + ' cores' : 'Unlimited'}</dd>
      <dt>Memory limit</dt><dd>${hc.Memory ? fmt.bytes(hc.Memory) : 'Unlimited'}</dd><dt>Privileged</dt><dd>${hc.Privileged ? 'Yes' : 'No'}</dd></dl></div>
      <div class="body flush"><table class="grid"><thead><tr><th>Type</th><th>Source</th><th>Mounted at</th><th>Access</th></tr></thead><tbody>${mounts || '<tr class="empty"><td colspan="4">No volumes or bind mounts</td></tr>'}</tbody></table></div>`);
    const nets = Object.entries((i.NetworkSettings || {}).Networks || {}).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="mono">${esc(v.IPAddress || '-')}</td><td class="mono">${esc(v.Gateway || '-')}</td><td class="mono">${esc(v.MacAddress || '-')}</td></tr>`).join('');
    setHTML($('#s-net', body), `<h3>${icon('net')}Networking</h3><div class="body"><dl class="kv"><dt>Network mode</dt><dd>${esc(hc.NetworkMode)}</dd></dl></div>
      <div class="body flush"><table class="grid"><thead><tr><th>Network</th><th>IP address</th><th>Gateway</th><th>MAC address</th></tr></thead><tbody>${nets || '<tr class="empty"><td colspan="4">Uses the host network stack</td></tr>'}</tbody></table></div>`);
    const env = (cfg.Env || []).map(e => { const k = e.split('=', 1)[0], v = e.slice(k.length + 1); const hide = SECRET_RE.test(k) && !reveal.has(k);
      return `<tr><td class="mono">${esc(k)}</td><td class="wrap mono">${hide ? `<span class="secret" data-act="reveal" data-k="${esc(k)}" title="Click to reveal">••••••••</span>` : esc(v)}</td></tr>`; }).join('');
    setHTML($('#s-env', body), `<h3>${icon('list')}Environment</h3><div class="body flush" style="max-height:260px;overflow:auto"><table class="grid"><tbody>${env || '<tr class="empty"><td>No environment variables</td></tr>'}</tbody></table></div>`);
    const labels = Object.entries(cfg.Labels || {}).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="wrap mono">${esc(v)}</td></tr>`).join('');
    setHTML($('#s-lab', body), `<h3>${icon('list')}Labels</h3><div class="body flush" style="max-height:260px;overflow:auto"><table class="grid"><tbody>${labels || '<tr class="empty"><td>No labels</td></tr>'}</tbody></table></div>`);
    if (!noteLoaded) { $('#note', body).value = det.note || ''; noteLoaded = true; }
  };
  const load = async () => {
    try { det = await api('/containers/' + enc(name)); missing = false; } catch (e) { if (/No such container/i.test(e.message)) { missing = true; det = null; } }
    try { thumb = det ? (await api(`/containers/${enc(name)}/logs?tail=22`)).text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') : ''; } catch { thumb = ''; }
    draw();
  };
  const charts = async () => {
    try {
      const m = await api(`/metrics?target=${enc(name)}&range=1h`);
      const base = { from: m.from, to: m.to, step: m.step, height: 150 };
      lineChart($('#s-c1', body), { ...base, label: 'CPU', floor: 1, fmt: cpuFmt, series: [{ name: 'CPU', color: 'var(--s1)', t: m.t, v: m.cpu }] });
      lineChart($('#s-c2', body), { ...base, label: 'Memory', binary: true, fmt: v => fmt.bytes(v), series: [{ name: 'Memory', color: 'var(--s1)', t: m.t, v: m.mem }] });
    } catch { /* retried */ }
  };
  const t1 = every(10000, load), t2 = every(30000, charts);
  wire(body, {
    thumb: () => go(`#/containers/${enc(name)}/${byName(name) && byName(name).state === 'running' ? 'console' : 'logs'}`),
    reveal: b => { reveal.add(b.dataset.k); draw(); },
    savenote: async () => { try { await api(`/containers/${enc(name)}/note`, { body: { text: $('#note', body).value } }); toast('Notes saved', '', 'ok'); } catch (e) { toast('Could not save notes', e.message, 'err'); } },
  });
  return { update: draw, refresh: load, destroy: () => { clearInterval(t1); clearInterval(t2); } };
};

TABS.monitor = (body, name) => {
  let range = '1h';
  body.innerHTML = `<div class="toolbar">${tb('refresh', 'refresh', 'Refresh')}<span class="sp"></span>${rangeSelect(range)}</div><div class="scroll pad"><div class="charts">
    ${['CPU (% of one core)', 'Memory', 'Network', 'Disk I/O'].map((t, i) => `<div class="panel"><h3>${t}</h3><div class="body"><div id="cm${i}"></div></div></div>`).join('')}</div></div>`;
  const load = async () => {
    try {
      const m = await api(`/metrics?target=${enc(name)}&range=${range}`);
      const base = { from: m.from, to: m.to, step: m.step, height: 190 };
      lineChart($('#cm0', body), { ...base, label: 'CPU', floor: 1, fmt: cpuFmt, series: [{ name: 'CPU', color: 'var(--s1)', t: m.t, v: m.cpu }] });
      lineChart($('#cm1', body), { ...base, label: 'Memory', binary: true, fmt: v => fmt.bytes(v), series: [{ name: 'Memory', color: 'var(--s1)', t: m.t, v: m.mem }] });
      lineChart($('#cm2', body), { ...base, label: 'Network', binary: true, fmt: fmt.rate, series: [{ name: 'Received', color: 'var(--s1)', t: m.t, v: m.rx }, { name: 'Transmitted', color: 'var(--s2)', t: m.t, v: m.tx }] });
      lineChart($('#cm3', body), { ...base, label: 'Disk I/O', binary: true, fmt: fmt.rate, series: [{ name: 'Read', color: 'var(--s1)', t: m.t, v: m.br }, { name: 'Write', color: 'var(--s2)', t: m.t, v: m.bw }] });
    } catch { /* retried */ }
  };
  const timer = every(30000, load);
  $('[data-range]', body).onchange = e => { range = e.target.value; load(); };
  wire(body, { refresh: load });
  return { refresh: load, destroy: () => clearInterval(timer) };
};

TABS.logs = (body, name) => {
  body.innerHTML = `<div class="toolbar"><label class="tb"><input type="checkbox" id="lfollow" checked> Follow</label><label class="tb"><input type="checkbox" id="lwrap" checked> Wrap lines</label>${SEP}
    ${tb('clear', 'trash', 'Clear')}${tb('save', 'down', 'Download')}${tb('reconnect', 'refresh', 'Reconnect')}<span class="sp"></span><span class="muted" id="lstate"></span>
    <input type="search" id="lfilter" placeholder="Filter lines" aria-label="Filter lines"></div><pre class="logbox" id="lbox" tabindex="0"></pre>`;
  const box = $('#lbox', body);
  let lines = [], partial = '', es = null, filter = '';
  const match = l => !filter || l.toLowerCase().includes(filter);
  const redraw = () => { box.textContent = lines.filter(match).join('\n') + (lines.length ? '\n' : ''); box.scrollTop = box.scrollHeight; };
  const push = text => {
    const parts = (partial + text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n')).split('\n');
    partial = parts.pop();
    if (!parts.length) return;
    lines.push(...parts);
    if (lines.length > 6000) { lines = lines.slice(-5000); return redraw(); }
    const add = parts.filter(match);
    if (add.length) box.append(add.join('\n') + '\n');
    if ($('#lfollow', body).checked) box.scrollTop = box.scrollHeight;
  };
  const connect = () => {
    if (es) es.close();
    lines = []; partial = ''; box.textContent = '';
    es = new EventSource(`/api/containers/${enc(name)}/logs/stream?tail=500`);
    $('#lstate', body).textContent = 'connecting…';
    es.onopen = () => { $('#lstate', body).textContent = 'live'; };
    es.onmessage = e => push(JSON.parse(e.data));
    es.addEventListener('end', () => { $('#lstate', body).textContent = 'stream ended (container stopped)'; es.close(); });
    es.onerror = () => { $('#lstate', body).textContent = 'disconnected'; es.close(); };
  };
  connect();
  $('#lwrap', body).onchange = e => box.classList.toggle('nowrap', !e.target.checked);
  $('#lfilter', body).oninput = e => { filter = e.target.value.toLowerCase(); redraw(); };
  wire(body, {
    clear: () => { lines = []; box.textContent = ''; },
    reconnect: connect,
    save: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' })); a.download = `${name}.log`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); },
  });
  let last = null;
  return {
    update() { const c = byName(name), st = c ? c.state : ''; if (last && last !== 'running' && st === 'running') connect(); last = st; },
    destroy: () => es && es.close(),
  };
};

let xtermLoading = null;
function loadXterm() {
  if (!xtermLoading) {
    xtermLoading = new Promise((ok, fail) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/xterm.css'; document.head.append(css);
      const add = (src, next) => { const s = document.createElement('script'); s.src = src; s.onload = next; s.onerror = () => fail(new Error('could not load ' + src)); document.head.append(s); };
      add('vendor/xterm.js', () => add('vendor/addon-fit.js', ok));
    });
  }
  return xtermLoading;
}
TABS.console = (body, name) => {
  body.innerHTML = `<div class="toolbar">${tb('reconnect', 'refresh', 'Reconnect')}<span class="muted" id="tstate" style="margin-left:8px"></span><span class="sp"></span><span class="muted">Interactive shell inside the container (bash, or sh when bash is absent)</span></div><div class="termwrap" id="term"></div>`;
  let ws = null, term = null, fit = null, dead = false, lastState = null;
  const state = t => { const s = $('#tstate', body); if (s) s.textContent = t; };
  const resize = () => { if (!fit || dead) return; try { fit.fit(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ resize: [term.cols, term.rows] })); } catch { /* not visible */ } };
  const ro = new ResizeObserver(resize);
  const connect = async () => {
    if (ws) ws.close();
    const c = byName(name);
    if (c && c.state !== 'running') return state('The container is not running. Power it on to open a console.');
    try { await loadXterm(); } catch (e) { return state(e.message); }
    if (dead) return;
    if (!term) {
      term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', cursorBlink: true, scrollback: 5000, theme: { background: '#000000' } });
      fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('#term', body));
      term.onData(d => { if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(d)); });
      ro.observe($('#term', body));
    } else term.reset();
    state('connecting…');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/containers/${enc(name)}/console`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { state('connected'); resize(); term.focus(); };
    ws.onmessage = e => term.write(new Uint8Array(e.data));
    ws.onclose = () => { state('session closed'); if (term) term.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n'); };
  };
  connect();
  wire(body, { reconnect: connect });
  return {
    update() { const c = byName(name), st = c ? c.state : ''; if (lastState !== null && lastState !== 'running' && st === 'running') connect(); lastState = st; },
    destroy() { dead = true; ro.disconnect(); if (ws) ws.close(); if (term) term.dispose(); },
  };
};

TABS.processes = (body, name) => {
  body.innerHTML = '<div class="scroll" id="pbox"></div>';
  const load = async () => {
    const c = byName(name);
    if (c && c.state !== 'running') return setHTML($('#pbox', body), '<div class="pad muted">The container is not running.</div>');
    try {
      const t = await api(`/containers/${enc(name)}/top`);
      setHTML($('#pbox', body), `<table class="grid"><thead><tr>${t.Titles.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${(t.Processes || []).map(p => `<tr>${p.map((x, i) => `<td class="${i === p.length - 1 ? 'wrap mono' : ''}">${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } catch (e) { setHTML($('#pbox', body), `<div class="pad muted">${esc(e.message)}</div>`); }
  };
  const timer = every(5000, load);
  return { refresh: load, destroy: () => clearInterval(timer) };
};

TABS.snapshots = (body, name) => {
  body.innerHTML = `<div class="toolbar">${tb('take', 'cam', 'Take snapshot')}${tb('revert', 'restart', 'Revert to snapshot')}${tb('del', 'trash', 'Delete', 'err')}${SEP}${tb('refresh', 'refresh', 'Refresh')}</div>`;
  const set = () => { const n = grid.selected().length; $('[data-act=revert]', body).disabled = n !== 1; $('[data-act=del]', body).disabled = n !== 1; };
  const grid = new Grid(gridHost(body), { key: r => r.id, onSelect: () => set(), empty: 'No snapshots. A snapshot captures the container filesystem so you can revert to it later.',
    cols: [{ key: 'name', label: 'Name' }, { key: 'comment', label: 'Description', cls: 'wrap' }, { key: 'created', label: 'Taken', html: r => fmt.date(r.created) },
      { key: 'size', label: 'Size', html: r => fmt.bytes(r.size), cls: 'num' }, { key: 'ref', label: 'Image', cls: 'mono' }] });
  const load = async () => { try { grid.set(await api(`/containers/${enc(name)}/snapshots`)); } catch { grid.set([]); } set(); };
  load();
  wire(body, {
    take: () => byName(name) && Act.snapshot(byName(name)),
    refresh: load,
    revert: () => { const s = grid.selected()[0]; confirmDialog('Revert to snapshot', `<p>Revert <b>${esc(name)}</b> to snapshot <b>${esc(s.name)}</b>?</p><p class="muted">The container is re-created from the snapshot image with its current configuration. Changes made to its filesystem since the snapshot are lost; volumes and bind mounts are untouched.</p>`, 'Revert', () => { run(`/containers/${enc(name)}/revert`, { body: { ref: s.ref } }); }, true); },
    del: () => { const s = grid.selected()[0]; confirmDialog('Delete snapshot', `<p>Delete snapshot <b>${esc(s.name)}</b>?</p>`, 'Delete', () => { run(`/images/${s.id}?force=1&label=${enc(s.name)}`, { method: 'DELETE' }); }, true); },
  });
  return { refresh: load };
};

TABS.events = (body, name) => {
  const grid = new Grid(gridHost(body), { key: r => r.i, empty: 'No events recorded for this container yet',
    cols: [{ key: 'ts', label: 'Time', html: r => fmt.date(r.ts) }, { key: 'action', label: 'Event' }, { key: 'detail', label: 'Details' }] });
  const load = async () => { try { grid.set((await api(`/events?limit=300&name=${enc(name)}`)).map((e, i) => ({ ...e, i: e.ts + ':' + i }))); } catch { /* retried */ } };
  const timer = every(10000, load);
  return { refresh: load, destroy: () => clearInterval(timer) };
};

/* =====================================================================
   Storage
   ===================================================================== */
VIEWS.storage = (el, args) => {
  const tab = args[0] || 'volumes';
  setTitle('db', 'Storage');
  const tabs = [['volumes', 'Volumes'], ['images', 'Images'], ['exports', 'Exports']];
  el.innerHTML = `<div class="pad" style="flex:none;padding-bottom:6px" id="st-sum"></div><div class="tabs">${tabs.map(t => `<a href="#/storage/${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}</a>`).join('')}</div>
    <div id="sbody" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`;
  const body = $('#sbody', el);
  const summary = async () => {
    try {
      const s = await api('/storage');
      const parts = [['Images', s.images, 'var(--s1)'], ['Volumes', s.volumes, 'var(--s2)'], ['Build cache', s.build_cache, 'var(--s3)'], ['Exports', s.exports, 'var(--s4)']];
      const known = parts.reduce((a, p) => a + p[1], 0), other = Math.max(0, s.disk_used - known);
      parts.push(['Other files', other, '#8a949b']);
      $('#st-sum', el).innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><b>Datastore</b><span class="muted">${fmt.bytes(s.disk_used)} used of ${fmt.bytes(s.disk_total)} · ${fmt.bytes(s.disk_total - s.disk_used)} free</span></div>
        <div class="stackbar">${parts.map(p => `<i title="${p[0]}: ${fmt.bytes(p[1])}" style="background:${p[2]};width:${(p[1] / s.disk_total * 100).toFixed(2)}%"></i>`).join('')}</div>
        <div class="legend" style="padding-left:0">${parts.map(p => `<span><i class="key" style="background:${p[2]};height:8px;width:8px"></i>${p[0]} ${fmt.bytes(p[1])}</span>`).join('')}</div>`;
    } catch { /* summary is optional */ }
  };
  summary();
  let grid, load;
  const used = r => r.used_by.map(n => `<a href="#/containers/${enc(n)}">${esc(n)}</a>`).join(', ') || '<span class="muted">unused</span>';
  if (tab === 'volumes') {
    body.innerHTML = `<div class="toolbar">${tb('del', 'trash', 'Delete', 'err')}${SEP}${tb('refresh', 'refresh', 'Refresh')}</div>`;
    const set = () => { const s = grid.selected(); $('[data-act=del]', body).disabled = !(s.length && s.every(r => !r.used_by.length)); };
    grid = new Grid(gridHost(body), { key: r => r.name, multi: true, sort: { key: 'name', dir: 1 }, onSelect: () => set(), search: r => r.name + r.project, empty: 'No volumes',
      cols: [{ key: 'name', label: 'Volume', html: r => `${icon('db')} ${esc(r.name.length > 40 ? r.name.slice(0, 12) + '… (anonymous)' : r.name)}` },
        { key: 'size', label: 'Size', cls: 'num', html: r => (r.size >= 0 ? fmt.bytes(r.size) : '-') }, { key: 'driver', label: 'Driver' },
        { key: 'project', label: 'Project' }, { key: 'used', label: 'Used by', nosort: true, html: used }, { key: 'created', label: 'Created', html: r => esc((r.created || '').replace('T', ' ').replace('Z', '')) }] });
    load = async () => { try { grid.set(await api('/volumes')); } catch (e) { toast('Could not list volumes', e.message, 'err'); } set(); };
    wire(body, { refresh: () => { load(); summary(); }, del: () => { const s = grid.selected(); confirmDialog('Delete volume', `<p>Permanently delete ${s.length === 1 ? `volume <b>${esc(s[0].name)}</b>` : `<b>${s.length}</b> volumes`} and all data stored in ${s.length === 1 ? 'it' : 'them'}?</p>`, 'Delete', () => { s.forEach(v => run('/volumes/' + enc(v.name), { method: 'DELETE' })); }, true); } });
  } else if (tab === 'images') {
    body.innerHTML = `<div class="toolbar">${tb('pull', 'down', 'Pull image')}${tb('del', 'trash', 'Delete', 'err')}${tb('prune', 'bolt', 'Remove dangling images')}${SEP}${tb('refresh', 'refresh', 'Refresh')}</div>`;
    const set = () => { $('[data-act=del]', body).disabled = !grid.selected().length; };
    const label = r => r.tags[0] || r.id.slice(7, 19);
    grid = new Grid(gridHost(body), { key: r => r.id, multi: true, sort: { key: 'tags', dir: 1 }, onSelect: () => set(), search: r => r.tags.join(' ') + r.id, empty: 'No images',
      cols: [{ key: 'tags', label: 'Image', val: r => label(r), html: r => (r.tags.length ? r.tags.map(esc).join('<br>') : '<span class="muted">&lt;untagged&gt;</span>') + (r.snapshot_of ? ` <span class="chip">snapshot of ${esc(r.snapshot_of)}</span>` : '') },
        { key: 'id', label: 'ID', cls: 'mono', html: r => r.id.slice(7, 19) }, { key: 'size', label: 'Size', cls: 'num', html: r => fmt.bytes(r.size) },
        { key: 'created', label: 'Created', html: r => fmt.date(r.created) }, { key: 'used', label: 'Used by', nosort: true, html: used }] });
    load = async () => { try { grid.set(await api('/images')); } catch (e) { toast('Could not list images', e.message, 'err'); } set(); };
    wire(body, {
      refresh: () => { load(); summary(); },
      pull: () => dialog({ title: 'Pull image', icon: 'down', body: '<div class="form"><label>Image</label><div><input type="text" name="ref" placeholder="nginx:alpine"><div class="hint">A repository reference, optionally with a tag or registry host.</div></div></div>',
        buttons: [{ label: 'Cancel' }, { label: 'Pull', cls: 'primary', fn: dlg => { const ref = formData(dlg).ref.trim(); if (!ref) throw new Error('Enter an image reference'); run('/images/pull', { body: { ref } }); } }] }),
      prune: () => confirmDialog('Remove dangling images', '<p>Delete all untagged images that no container uses?</p>', 'Remove', () => { run('/images/prune'); }),
      del: () => { const s = grid.selected(); const busy = s.filter(r => r.used_by.length);
        confirmDialog('Delete image', `<p>Delete ${s.length === 1 ? `image <b>${esc(label(s[0]))}</b>` : `<b>${s.length}</b> images`}?</p>${busy.length ? `<p class="warn">${icon('warn')} ${busy.length} of them ${busy.length === 1 ? 'is' : 'are'} used by containers and will be skipped by Docker.</p>` : ''}`, 'Delete', () => { s.forEach(i => run(`/images/${i.id}?label=${enc(label(i))}`, { method: 'DELETE' })); }, true); },
    });
  } else {
    body.innerHTML = `<div class="toolbar">${tb('import', 'up', 'Import…')}${SEP}${tb('deploy', 'play', 'Deploy', 'ok')}${tb('download', 'down', 'Download')}${tb('del', 'trash', 'Delete', 'err')}${SEP}${tb('refresh', 'refresh', 'Refresh')}</div>`;
    const set = () => { const one = grid.selected().length === 1; ['deploy', 'download', 'del'].forEach(a => { $(`[data-act=${a}]`, body).disabled = !one; }); };
    grid = new Grid(gridHost(body), { key: r => r.file, sort: { key: 'mtime', dir: -1 }, onSelect: () => set(), search: r => r.file, onOpen: r => deployExport(r.file),
      empty: 'No exported bundles. Select a container and choose Actions › Export to create one.',
      cols: [{ key: 'file', label: 'Bundle', html: r => `${icon('file')} ${esc(r.file)}` }, { key: 'contains', label: 'Contains', nosort: true, html: r => r.containers.map(c => `<span class="chip" title="${esc(c.image)}">${esc(c.name)}</span>`).join('') || '<span class="muted">not a Drydock bundle</span>' },
        { key: 'host', label: 'Exported from' }, { key: 'size', label: 'Size', cls: 'num', html: r => fmt.bytes(r.size) }, { key: 'mtime', label: 'Created', html: r => fmt.date(r.mtime) }] });
    load = async () => { try { grid.set(await api('/exports')); } catch (e) { toast('Could not list exports', e.message, 'err'); } set(); };
    wire(body, {
      refresh: () => { load(); summary(); }, import: () => openWizard('archive'),
      deploy: () => deployExport(grid.selected()[0].file),
      download: () => { const a = document.createElement('a'); a.href = '/api/exports/' + enc(grid.selected()[0].file); a.download = ''; a.click(); },
      del: () => { const f = grid.selected()[0].file; confirmDialog('Delete bundle', `<p>Delete <b>${esc(f)}</b> from the datastore?</p>`, 'Delete', async () => { await api('/exports/' + enc(f), { method: 'DELETE' }); load(); summary(); }, true); },
    });
  }
  load();
  return { refresh: () => { load(); summary(); } };
};

/* Options shown for an archive once Drydock knows what it is. */
function importOptions(info) {
  if (info.kind === 'bundle') {
    const m = info.manifest;
    return `<div class="banner info">${icon('ok', 'ok')}<span>Drydock bundle exported from <b>${esc(m.host || 'unknown host')}</b> on ${fmt.date(m.created)}.</span></div>
      <table class="grid" style="margin-bottom:10px"><thead><tr><th>Container</th><th>Name on this host</th><th>Image</th><th>Includes</th></tr></thead><tbody>${m.containers.map(c => `<tr>
        <td>${esc(c.name)}</td><td><input type="text" name="n:${esc(c.name)}" value="${esc(c.exists ? c.name + '-imported' : c.name)}" style="width:170px">${c.exists ? `<div class="hint warn">${esc(c.name)} already exists here</div>` : ''}</td>
        <td class="wrap">${esc(c.original_image)}</td><td class="wrap">${c.volumes.length} volume${c.volumes.length === 1 ? '' : 's'}${c.binds.length ? `, ${c.binds.length} bind mount${c.binds.length === 1 ? '' : 's'} (paths only)` : ''}${c.ports.length ? `<br><span class="muted">ports ${esc(c.ports.join(', '))}</span>` : ''}</td></tr>`).join('')}</tbody></table>
      <label class="check"><input type="checkbox" name="start" checked><span>Power on after import</span></label>
      <label class="check"><input type="checkbox" name="restore_volumes" checked><span>Restore volume data from the bundle<br><small class="muted">Existing files in a volume of the same name are overwritten.</small></span></label>`;
  }
  if (info.kind === 'image') return `<div class="banner info">${icon('ok', 'ok')}<span>Docker image archive. It will be loaded into the local image store; create a container from it afterwards.</span></div>`;
  if (info.kind === 'project') {
    const docker = /Dockerfile$/.test(info.entry || '');
    return `<div class="banner info">${icon('ok', 'ok')}<span>Project archive (${esc(info.entry)}, ${info.files} files). It will be unpacked into Drydock's imported projects.</span></div>
      <div class="form"><label>Project name</label><div><input type="text" name="name" value="${esc((info.name || 'project').replace(/^[0-9a-f]{8}-/, '').replace(/\.(tar\.gz|tgz|tar|zip)$/i, '').replace(/[^a-zA-Z0-9_.-]/g, '-'))}"></div>
      ${docker ? '<label>Port mappings</label><div><textarea name="ports" rows="2" placeholder="8080:80"></textarea><div class="hint">host:container, one per line. Leave empty to publish the image\'s exposed ports on random host ports.</div></div>' : ''}
      <label></label><div><label class="check"><input type="checkbox" name="deploy" checked><span>Build and power on after import</span></label></div></div>`;
  }
  return `<div class="banner error">${icon('warn', 'err')}<span>Unrecognised archive. Expected a Drydock bundle, a <span class="mono">docker save</span> image archive, or a project (tar/zip) with a compose file or Dockerfile.</span></div>`;
}
function importBody(root) {
  const f = formData(root), names = {};
  for (const k of Object.keys(f)) if (k.startsWith('n:')) { names[k.slice(2)] = f[k].trim(); delete f[k]; }
  return { ...f, names };
}
async function deployExport(file) {
  let info;
  try { info = await api(`/exports/${enc(file)}/deploy`); } catch (e) { return toast('Cannot read bundle', e.message, 'err'); }
  info.name = file;
  dialog({ title: `Deploy ${file}`, icon: 'up', wide: true, body: importOptions(info),
    buttons: [{ label: 'Cancel' }, ...(info.kind === 'unknown' ? [] : [{ label: 'Deploy', cls: 'primary', fn: async dlg => {
      const r = await api(`/exports/${enc(file)}/deploy`, { body: importBody(dlg) });
      S.taskState[r.task] = 'queued'; setTimeout(poll, 400);
    } }])] });
}
function upload(file, onProgress) {
  return new Promise((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open('PUT', '/api/upload?name=' + enc(file.name));
    x.setRequestHeader('X-Drydock', '1');
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { /* not json */ } if (x.status === 200) ok(d); else fail(new Error(d.error || `Upload failed (${x.status})`)); };
    x.onerror = () => fail(new Error('Upload failed: connection lost'));
    x.send(file);
  });
}

/* =====================================================================
   Networking
   ===================================================================== */
VIEWS.networking = (el, args) => {
  const tab = args[0] || 'networks';
  setTitle('net', 'Networking');
  const tabs = [['networks', 'Networks'], ['ports', 'Port mappings']];
  el.innerHTML = `<div class="tabs">${tabs.map(t => `<a href="#/networking/${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}</a>`).join('')}</div>`;
  if (tab === 'ports') {
    const grid = new Grid(gridHost(el), { key: r => r.k, sort: { key: 'host', dir: 1 }, empty: 'No ports are published on this host', search: r => r.name + r.host,
      cols: [{ key: 'host', label: 'Host port', cls: 'num', html: r => (r.proto === 'tcp' ? `<a href="http://${location.hostname}:${r.host}" target="_blank" rel="noopener">${r.host}</a>` : r.host) },
        { key: 'proto', label: 'Protocol' }, { key: 'name', label: 'Container', html: r => `<span class="st">${stateIcon(r.c)}<a href="#/containers/${enc(r.name)}">${esc(r.name)}</a></span>` },
        { key: 'container', label: 'Container port', cls: 'num' }, { key: 'state', label: 'Status', html: r => esc(stateText(r.c)) }] });
    return { update(o) { grid.set(o.containers.flatMap(c => c.ports.map(p => ({ ...p, name: c.name, c, state: c.state, k: `${c.name}:${p.host}/${p.proto}` })))); } };
  }
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  bar.innerHTML = `${tb('del', 'trash', 'Delete', 'err')}${SEP}${tb('refresh', 'refresh', 'Refresh')}`;
  el.append(bar);
  const builtin = ['bridge', 'host', 'none'];
  const set = () => { const s = grid.selected(); $('[data-act=del]', bar).disabled = !(s.length === 1 && !s[0].containers.length && !builtin.includes(s[0].name)); };
  const grid = new Grid(gridHost(el), { key: r => r.id, sort: { key: 'name', dir: 1 }, onSelect: () => set(), search: r => r.name + r.subnet, empty: 'No networks',
    cols: [{ key: 'name', label: 'Network', html: r => `${icon('net')} ${esc(r.name)}${builtin.includes(r.name) ? ' <span class="chip">built-in</span>' : ''}` }, { key: 'driver', label: 'Driver' },
      { key: 'subnet', label: 'Subnet', cls: 'mono' }, { key: 'gateway', label: 'Gateway', cls: 'mono' },
      { key: 'containers', label: 'Attached containers', cls: 'wrap', val: r => r.containers.length, html: r => r.containers.map(c => `<a class="chip" href="#/containers/${enc(c.name)}" title="${esc(c.ip)}">${esc(c.name)}</a>`).join('') || '<span class="muted">none</span>' }] });
  const load = async () => { try { grid.set(await api('/networks')); } catch (e) { toast('Could not list networks', e.message, 'err'); } set(); };
  load();
  wire(bar, { refresh: load, del: () => { const n = grid.selected()[0]; confirmDialog('Delete network', `<p>Delete network <b>${esc(n.name)}</b>?</p>`, 'Delete', () => { run(`/networks/${n.id}?label=${enc(n.name)}`, { method: 'DELETE' }); }, true); } });
  return { refresh: load };
};

/* =====================================================================
   Projects
   ===================================================================== */
VIEWS.projects = el => {
  setTitle('folder', 'Projects');
  el.innerHTML = `<div class="toolbar">${tb('deploy', 'play', 'Register / Deploy', 'ok')}${tb('down', 'stop', 'Unregister', 'err')}${SEP}${tb('view', 'file', 'View definition')}${tb('import', 'up', 'Import…')}${tb('del', 'trash', 'Delete imported', 'err')}${SEP}${tb('refresh', 'refresh', 'Refresh')}
    <span class="sp"></span><input type="search" id="pfilter" placeholder="Search" aria-label="Search"></div>`;
  const set = () => {
    const s = grid.selected()[0], b = (a, on) => { $(`[data-act=${a}]`, el).disabled = !on; };
    b('deploy', s && !s.self); b('down', s && s.containers.length && !s.self); b('view', !!s); b('del', s && s.origin === 'imported' && !s.containers.length);
    if (s) $('[data-act=deploy]', el).lastChild.textContent = s.containers.length ? 'Rebuild / Redeploy' : 'Register / Deploy';
  };
  const deploy = p => {
    const docker = p.kind === 'dockerfile';
    dialog({ title: `${p.containers.length ? 'Redeploy' : 'Register'} ${p.name}`, icon: 'play', body: `<p>${docker
        ? `Builds an image from <span class="mono">${esc(p.path)}/Dockerfile</span> and runs it as a container.`
        : `Runs <span class="mono">docker compose up -d</span> for <span class="mono">${esc(p.path)}/${esc(p.entry)}</span>. Existing containers of this project are updated in place.`}</p>
      ${docker ? `<div class="form"><label>Container name</label><div><input type="text" name="name" value="${esc(p.containers[0] ? p.containers[0].name : p.name.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'))}"></div>
        <label>Port mappings</label><div><textarea name="ports" rows="2" placeholder="8080:80"></textarea><div class="hint">host:container, one per line. Empty publishes the image's exposed ports on random host ports.</div></div>
        <label>Environment</label><div><textarea name="env" rows="2" placeholder="KEY=value"></textarea></div></div>`
        : '<label class="check"><input type="checkbox" name="build" checked><span>Rebuild images before starting</span></label>'}`,
      buttons: [{ label: 'Cancel' }, { label: p.containers.length ? 'Redeploy' : 'Deploy', cls: 'primary', fn: async dlg => {
        const r = await api('/projects/deploy', { body: { path: p.path, ...formData(dlg) } });
        S.taskState[r.task] = 'queued'; setTimeout(poll, 400); taskDialog(r.task); return false;
      } }] });
  };
  const grid = new Grid(gridHost(el), { key: r => r.path, sort: { key: 'name', dir: 1 }, onSelect: () => set(), search: r => r.name + r.path, onOpen: deploy,
    empty: 'No projects found. A project is a directory containing a compose file or a Dockerfile.',
    cols: [{ key: 'name', label: 'Project', html: r => `${icon('folder')} ${esc(r.name)}${r.self ? ' <span class="chip">this console</span>' : ''}` },
      { key: 'kind', label: 'Type', html: r => (r.kind === 'compose' ? 'Compose project' : 'Dockerfile') },
      { key: 'status', label: 'Status', val: r => r.containers.length, html: r => { const n = r.containers.length, up = r.containers.filter(c => c.state === 'running').length;
        return n ? `<span class="st">${icon(up ? 'play' : 'stop', up ? 'ok' : 'off')}Registered</span> <span class="muted">(${up}/${n} running)</span>` : '<span class="muted">Not registered</span>'; } },
      { key: 'containers', label: 'Containers', nosort: true, cls: 'wrap', html: r => r.containers.map(c => `<a class="chip" href="#/containers/${enc(c.name)}">${esc(c.name)}</a>`).join('') },
      { key: 'origin', label: 'Origin', html: r => (r.origin === 'imported' ? 'Imported' : 'Host directory') }, { key: 'path', label: 'Location', cls: 'mono' },
      { key: 'mtime', label: 'Definition changed', html: r => fmt.date(r.mtime) }] });
  const load = async () => { try { grid.set(await api('/projects')); } catch (e) { toast('Could not list projects', e.message, 'err'); } set(); };
  load();
  $('#pfilter', el).oninput = e => { grid.filter = e.target.value; grid.draw(); };
  wire(el, {
    refresh: load, import: () => openWizard('archive'), deploy: () => deploy(grid.selected()[0]),
    down: () => { const p = grid.selected()[0]; confirmDialog('Unregister project', `<p>Stop and remove the ${p.containers.length} container${p.containers.length === 1 ? '' : 's'} of <b>${esc(p.name)}</b>?</p><p class="muted">The project directory, its images and its volumes are kept, so it can be registered again.</p>`, 'Unregister', () => { run('/projects/down', { body: { path: p.path } }); }, true); },
    view: async () => { const p = grid.selected()[0]; try { const f = await api('/projects/file?path=' + enc(p.path)); dialog({ title: `${p.name}/${f.file}`, icon: 'file', wide: true, body: `<pre class="code">${esc(f.text)}</pre>`, buttons: [{ label: 'Close' }] }); } catch (e) { toast('Cannot read file', e.message, 'err'); } },
    del: () => { const p = grid.selected()[0]; confirmDialog('Delete imported project', `<p>Delete the imported project directory <span class="mono">${esc(p.path)}</span>?</p>`, 'Delete', async () => { await api('/projects/delete', { body: { path: p.path } }); load(); }, true); },
  });
  return { refresh: load };
};

/* =====================================================================
   Create / Register wizard
   ===================================================================== */
function openWizard(startType) {
  const W = { step: startType ? 1 : 0, type: startType || 'image', f: { restart: 'unless-stopped', start: true, deploy: true, build: true }, projects: null, info: null };
  const TYPES = [
    ['image', 'Create a new container from an image', 'Pick an image from this host or a registry and configure ports, volumes and environment.'],
    ['project', 'Register an existing project', 'Deploy a directory on this host that contains a compose file or a Dockerfile.'],
    ['archive', 'Import a bundle, image or project archive', 'Upload a Drydock bundle (.drydock.tar.gz), a docker save archive, or a zipped project.'],
    ['git', 'Clone a project from a Git repository', 'Fetch a repository that contains a compose file or Dockerfile and deploy it.'],
  ];
  const STEPS = ['Select creation type', 'Configure', 'Ready to complete'];
  const dlg = dialog({ title: 'New container', icon: 'plus', wide: true, body: '', buttons: [] });
  $('.d-body', dlg).style.padding = '0';
  const foot = $('.d-foot', dlg);
  const err = t => { $('.d-err', dlg).textContent = t || ''; };
  const save = () => Object.assign(W.f, formData($('.wiz-page', dlg) || dlg));
  const val = k => esc(W.f[k] || '');
  const chk = k => (W.f[k] ? 'checked' : '');

  const pages = {
    image: () => `<h4>Container settings</h4><p class="lead">The image is pulled automatically when it is not present on this host.</p><div class="form">
      <label>Name</label><div><input type="text" name="name" value="${val('name')}" placeholder="my-container"></div>
      <label>Image</label><div><input type="text" name="image" value="${val('image')}" placeholder="nginx:alpine" list="imglist"><datalist id="imglist"></datalist></div>
      <label>Port mappings</label><div><textarea name="ports" rows="2" placeholder="8080:80">${val('ports')}</textarea><div class="hint">host:container[/udp], one per line.</div></div>
      <label>Volumes</label><div><textarea name="volumes" rows="2" placeholder="mydata:/data&#10;/host/path:/config:ro">${val('volumes')}</textarea><div class="hint">volume-or-host-path:container-path[:ro], one per line.</div></div>
      <label>Environment</label><div><textarea name="env" rows="2" placeholder="KEY=value">${val('env')}</textarea></div>
      <label>Command</label><div><input type="text" name="cmd" value="${val('cmd')}" placeholder="(image default)"></div>
      <label>Autostart</label><div><select name="restart">${[['unless-stopped', 'Start with host, unless powered off'], ['always', 'Always restart'], ['on-failure', 'Restart on failure'], ['no', 'Disabled']].map(o => `<option value="${o[0]}" ${W.f.restart === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>
      <label>CPU limit (cores)</label><div><input type="number" name="cpus" min="0" step="0.25" value="${val('cpus')}" placeholder="unlimited"></div>
      <label>Memory limit (MB)</label><div><input type="number" name="memory" min="0" step="64" value="${val('memory')}" placeholder="unlimited"></div>
      <label></label><div><label class="check"><input type="checkbox" name="start" ${chk('start')}><span>Power on after creation</span></label></div></div>`,
    project: () => {
      if (!W.projects) return '<h4>Select a project</h4><p class="lead">Scanning project directories…</p>';
      const list = W.projects.filter(p => !p.self);
      const cur = list.find(p => p.path === W.f.path);
      return `<h4>Select a project</h4><p class="lead">Directories under the projects root that contain a compose file or a Dockerfile.</p>
        <div class="pick" style="max-height:230px;overflow:auto">${list.map(p => `<label class="${p.path === W.f.path ? 'on' : ''}"><input type="radio" name="path" value="${esc(p.path)}" ${p.path === W.f.path ? 'checked' : ''}>
          <span><b>${esc(p.name)}</b><small>${p.kind === 'compose' ? 'Compose project' : 'Dockerfile'} · ${esc(p.path)} · ${p.containers.length ? 'registered, ' + p.containers.length + ' container(s)' : 'not registered'}</small></span></label>`).join('') || '<div class="pad muted">No projects found.</div>'}</div>
        ${cur && cur.kind === 'dockerfile' ? `<div class="form" style="margin-top:12px"><label>Container name</label><div><input type="text" name="name" value="${val('name') || esc(cur.name.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'))}"></div>
          <label>Port mappings</label><div><textarea name="ports" rows="2" placeholder="8080:80">${val('ports')}</textarea></div></div>`
          : cur ? `<label class="check" style="margin-top:12px"><input type="checkbox" name="build" ${chk('build')}><span>Rebuild images before starting</span></label>` : ''}`;
    },
    archive: () => `<h4>Select an archive</h4><p class="lead">Drydock inspects the file and works out how to import it.</p>
      ${W.info ? `<div style="margin-bottom:10px">${icon('file')} <b>${esc(W.info.name)}</b> <span class="muted">(${fmt.bytes(W.info.size)})</span> · <a data-act="again">choose another file</a></div>${importOptions(W.info)}`
        : `<div class="drop" id="drop">${icon('up')}<p>Drop a file here, or</p><input type="file" id="file" accept=".gz,.tgz,.tar,.zip"><div class="progress" hidden><i></i></div><div id="upmsg" class="muted" style="margin-top:6px"></div></div>`}`,
    git: () => `<h4>Clone from Git</h4><p class="lead">The repository is cloned into Drydock's imported projects.</p><div class="form">
      <label>Repository URL</label><div><input type="text" name="url" value="${val('url')}" placeholder="https://github.com/user/project.git"></div>
      <label>Project name</label><div><input type="text" name="name" value="${val('name')}" placeholder="(from the URL)"></div>
      <label></label><div><label class="check"><input type="checkbox" name="deploy" ${chk('deploy')}><span>Build and power on after cloning</span></label></div></div>`,
  };
  const review = () => {
    const f = W.f, rows = [];
    const add = (k, v) => { if (v !== '' && v != null) rows.push(`<dt>${k}</dt><dd>${esc(v)}</dd>`); };
    add('Type', TYPES.find(t => t[0] === W.type)[1]);
    if (W.type === 'image') { add('Name', f.name); add('Image', f.image); add('Ports', (f.ports || '').split('\n').filter(Boolean).join(', ')); add('Volumes', (f.volumes || '').split('\n').filter(Boolean).join(', ')); add('Autostart', f.restart); add('CPU limit', f.cpus); add('Memory limit (MB)', f.memory); add('Power on', f.start ? 'Yes' : 'No'); }
    if (W.type === 'project') { add('Project', f.path); add('Action', 'Build and start'); }
    if (W.type === 'archive' && W.info) { add('File', W.info.name); add('Detected as', { bundle: 'Drydock bundle', image: 'Docker image archive', project: 'Project archive' }[W.info.kind]);
      if (W.info.kind === 'bundle') { add('Containers', Object.values(W.body.names).join(', ')); add('Power on', W.body.start ? 'Yes' : 'No'); add('Restore volume data', W.body.restore_volumes ? 'Yes' : 'No'); }
      if (W.info.kind === 'project') { add('Project name', W.body.name); add('Deploy', W.body.deploy ? 'Yes' : 'No'); } }
    if (W.type === 'git') { add('Repository', f.url); add('Project name', f.name || '(from the URL)'); add('Deploy', f.deploy ? 'Yes' : 'No'); }
    return `<h4>Ready to complete</h4><p class="lead">Review the settings, then click Finish. Progress is shown in Recent tasks.</p><dl class="kv">${rows.join('')}</dl>`;
  };
  const validate = () => {
    const f = W.f;
    if (W.type === 'image') { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.name || '')) return 'Enter a container name (letters, digits, _ . -)'; if (!(f.image || '').trim()) return 'Enter an image'; }
    if (W.type === 'project' && !f.path) return 'Select a project';
    if (W.type === 'archive') { if (!W.info) return 'Choose a file to upload'; if (W.info.kind === 'unknown') return 'This archive cannot be imported'; W.body = importBody($('.wiz-page', dlg)); }
    if (W.type === 'git' && !/^(https?:\/\/|git@|ssh:\/\/)\S+$/.test(f.url || '')) return 'Enter a repository URL';
    return '';
  };
  const finish = async () => {
    const f = W.f;
    let r;
    if (W.type === 'image') r = await api('/create', { body: f });
    else if (W.type === 'project') r = await api('/projects/deploy', { body: { path: f.path, name: f.name, ports: f.ports, build: f.build } });
    else if (W.type === 'archive') r = await api('/import', { body: { upload: W.info.upload, ...W.body } });
    else r = await api('/git', { body: { url: f.url, name: f.name, deploy: f.deploy } });
    S.taskState[r.task] = 'queued'; setTimeout(poll, 400);
    closeDialog();
    if (W.type !== 'image') taskDialog(r.task);
  };
  const render = () => {
    err('');
    const page = W.step === 0 ? `<h4>Select creation type</h4><p class="lead">How would you like to add a container to this host?</p><div class="pick">${TYPES.map(t => `<label class="${W.type === t[0] ? 'on' : ''}"><input type="radio" name="type" value="${t[0]}" ${W.type === t[0] ? 'checked' : ''}><span><b>${t[1]}</b><small>${t[2]}</small></span></label>`).join('')}</div>`
      : W.step === 1 ? pages[W.type]() : review();
    $('.d-body', dlg).innerHTML = `<div class="wiz"><div class="wiz-steps">${STEPS.map((s, i) => `<div class="${i === W.step ? 'on' : i < W.step ? 'done' : ''}">${i + 1}&nbsp; ${s}</div>`).join('')}</div><div class="wiz-page">${page}</div></div>`;
    foot.innerHTML = `<span class="d-err"></span><button class="btn" data-w="back" ${W.step === 0 ? 'disabled' : ''}>Back</button><button class="btn ${W.step < 2 ? 'primary' : ''}" data-w="next" ${W.step === 2 ? 'disabled' : ''}>Next</button><button class="btn ${W.step === 2 ? 'primary' : ''}" data-w="finish" ${W.step === 2 ? '' : 'disabled'}>Finish</button><button class="btn" data-w="cancel">Cancel</button>`;
    if (W.step === 1 && W.type === 'image') api('/images').then(imgs => { const dl = $('#imglist', dlg); if (dl) dl.innerHTML = imgs.flatMap(i => i.tags).map(t => `<option value="${esc(t)}">`).join(''); }).catch(() => {});
    if (W.step === 1 && W.type === 'project' && !W.projects) api('/projects').then(p => { W.projects = p; if (W.step === 1 && W.type === 'project') render(); }).catch(e => err(e.message));
    const drop = $('#drop', dlg);
    if (drop) {
      const send = async file => {
        if (!file) return;
        const bar = $('.progress', drop); bar.hidden = false; $('#file', drop).hidden = true;
        try {
          W.info = await upload(file, p => { $('i', bar).style.width = (p * 100).toFixed(1) + '%'; $('#upmsg', drop).textContent = p < 1 ? `Uploading ${file.name}… ${(p * 100).toFixed(0)}%` : 'Inspecting archive…'; });
          render();
        } catch (e) { err(e.message); bar.hidden = true; $('#file', drop).hidden = false; $('#upmsg', drop).textContent = ''; }
      };
      $('#file', drop).onchange = e => send(e.target.files[0]);
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); send(e.dataTransfer.files[0]); };
    }
  };
  $('.d-body', dlg).addEventListener('change', e => {
    if (e.target.name === 'type') { W.type = e.target.value; render(); }
    if (e.target.name === 'path') { save(); W.f.name = ''; render(); }
  });
  $('.d-body', dlg).addEventListener('click', e => { if (e.target.closest('[data-act=again]')) { W.info = null; render(); } });
  foot.addEventListener('click', async e => {
    const b = e.target.closest('[data-w]');
    if (!b || b.disabled) return;
    const w = b.dataset.w;
    if (w === 'cancel') return closeDialog();
    if (w === 'back') { if (W.step === 1) save(); W.step--; return render(); }
    if (w === 'next') {
      if (W.step === 1) { save(); const m = validate(); if (m) return err(m); }
      W.step++; return render();
    }
    b.disabled = true;
    try { await finish(); } catch (ex) { err(ex.message); b.disabled = false; }
  });
  render();
}
