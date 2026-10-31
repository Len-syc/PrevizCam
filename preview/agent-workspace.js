import { clone, totalDuration, requiredTimes, requiredFrames, missingTimes } from './core.mjs';
import { CHECK_LIMITATIONS, refuse, previsPlan } from './commands.mjs';
import { AgentRenderer } from './agent-renderer.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusName = { editing: '编辑中', submitted: '待审阅', applied: '已应用', running: '导出中', completed: '已完成', cancelled: '已取消', failed: '失败' };
const errorInfo = error => ({ code: error.code || 'COMMAND_FAILED', message: error.message || String(error),
  ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
  ...(error.details ? { details: error.details } : {}) });
const FRAME_LIMIT = 12;
const BUSY_WAIT = 15000;

export class AgentWorkspace {
  constructor({ commands, getProject, getBytes, spatialData, pause, toast, assertReady, createEmpty }) {
    Object.assign(this, { commands, getProject, getBytes, spatialData, pause, toast, assertReady, createEmpty });
    this.jobs = new Map(); this.requests = new Map(); this.busy = null; this.review = null; this.enabled = false;
    // Which times the agent has actually rendered per draft version: the review gate
    // would otherwise be a guess, and the agent would guess back with sleeps.
    this.seen = new Map();
    this.connectionText = '未连接'; this.installUI();
    const previous = commands.onChange;
    commands.onChange = () => { previous(); this.publish(); this.updateUI(); };
    document.getElementById('open-agent').addEventListener('click', () => this.open());
    window.addEventListener('pagehide', () => { this.enabled = false; clearTimeout(this.retry); this.abortAll('PAGE_CLOSED', '页面已关闭。'); this.socket?.close(); });
  }
  get reviewing() { return Boolean(this.review); }
  renderer() { return this.renderEngine ||= new AgentRenderer(); }
  installUI() {
    this.dialog = document.createElement('dialog'); this.dialog.id = 'agent-dialog'; this.dialog.className = 'agent-dialog';
    this.dialog.setAttribute('aria-labelledby', 'agent-dialog-title');
    this.dialog.innerHTML = `<div class="dialog-heading"><div><span class="small-kicker">AGENT / REVIEW</span><h2 id="agent-dialog-title">Agent 草案</h2></div><button id="agent-close" aria-label="关闭 Agent 草案">关闭</button></div>
      <div class="agent-body"><div class="agent-connection"><label for="agent-port">本机桥接端口</label><input id="agent-port" type="number" min="1024" max="65535" value="8900"><button id="agent-connect">连接本机 Agent</button><span id="agent-connection-state" role="status">未连接</span></div>
      <p class="field-help">先在外部助手启动 PrevizCam MCP，再连接此页面。Agent 的修改保存在草案中，应用后可整套撤销。草案保留在当前页面会话，刷新前请完成审阅或导出。</p>
      <div id="agent-workspace-id" class="field-help mono"></div><div id="agent-error" class="error-text" role="alert" hidden></div>
      <section id="agent-drafts" aria-label="预演草案"></section>
      <section id="agent-review" hidden><div class="agent-review-heading"><h3 id="agent-review-name"></h3><button id="agent-back">返回草案列表</button></div>
      <p id="agent-review-summary"></p><div id="agent-preview-monitor" class="agent-preview-monitor"></div>
      <div class="agent-preview-transport"><button id="agent-preview-play">播放草案</button><label for="agent-preview-time">预演时间</label><input id="agent-preview-time" type="range" min="0" max="1" value="0" step="0.041666667"><output id="agent-preview-label"></output></div>
      <div id="agent-review-report"></div><div class="dialog-footer"><span id="agent-review-state" class="field-help"></span><button id="agent-apply" class="button-accent">应用整套草案</button></div></section>
      <section id="agent-jobs" aria-label="导出任务" aria-live="polite"></section></div>`;
    document.body.append(this.dialog);
    this.el = id => this.dialog.querySelector(`#${id}`);
    this.el('agent-close').addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.el('agent-connect').addEventListener('click', () => this.runUI(() => {
      if (this.enabled) { this.enabled = false; clearTimeout(this.retry); this.socket?.close(); this.abortAll('DISCONNECTED', '已手动断开连接。'); this.setConnection('未连接'); }
      else { const port = Number(this.el('agent-port').value); if (!Number.isInteger(port) || port < 1024 || port > 65535) refuse('INVALID_PORT', '端口应为 1024–65535。'); this.enabled = true; this.connect(port); }
      this.updateUI();
    }));
    this.el('agent-drafts').addEventListener('click', event => {
      const b = event.target.closest('button'); if (!b) return;
      if (b.dataset.review) void this.runUI(() => this.startReview(b.dataset.review));
      if (b.dataset.discard) void this.runUI(() => this.commands.discard(b.dataset.discard));
    });
    this.el('agent-back').addEventListener('click', () => this.endReview());
    this.el('agent-preview-play').addEventListener('click', () => {
      if (!this.review) return;
      this.review.playing = !this.review.playing;
      if (this.review.time >= totalDuration(this.review.project.shots)) this.review.time = 0;
      this.review.last = performance.now(); this.el('agent-preview-play').textContent = this.review.playing ? '暂停草案' : '播放草案';
    });
    this.el('agent-preview-time').addEventListener('input', event => { if (this.review) { this.review.time = Number(event.target.value); this.review.playing = false; this.el('agent-preview-play').textContent = '播放草案'; } });
    this.el('agent-apply').addEventListener('click', () => this.runUI(() => {
      if (!this.review) return;
      const { id, version } = this.review;
      // Validation/commit must succeed before dismissing the reviewed candidate.
      this.commands.accept(id, version); this.endReview(); this.toast('预演草案已整套应用，可用撤销恢复原项目。');
    }));
    this.el('agent-jobs').addEventListener('click', event => { const id = event.target.closest('[data-cancel-job]')?.dataset.cancelJob; if (id) this.cancelJob(id); });
  }
  async runUI(fn) {
    this.el('agent-error').hidden = true;
    try { await fn(); } catch (error) { this.el('agent-error').textContent = error.message; this.el('agent-error').hidden = false; }
  }
  open() { this.updateUI(); if (!this.dialog.open) this.dialog.showModal(); }
  close() { this.endReview(); this.dialog.close(); }
  setConnection(text) { this.connectionText = text; this.updateUI(); }
  connect(port) {
    clearTimeout(this.retry); this.port = port; this.setConnection('正在连接…');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`); this.socket = socket;
    socket.addEventListener('open', () => {
      if (!this.enabled || this.socket !== socket) { socket.close(); return; }
      socket.send(JSON.stringify({ kind: 'hello', protocol: 1, workspaceId: this.commands.workspaceId, name: this.getProject().name, revision: this.commands.revision }));
    });
    socket.addEventListener('message', event => {
      let m; try { m = JSON.parse(event.data); } catch { socket.close(); return; }
      if (m.kind === 'connected') { this.setConnection('已连接 · 草案模式'); return; }
      if (m.kind === 'cancelRequest') { this.requests.get(m.id)?.abort(); return; }
      if (m.kind !== 'request' || typeof m.id !== 'string') return;
      const controller = new AbortController(); this.requests.set(m.id, controller);
      Promise.resolve().then(() => this.dispatch(m.method, m.args || {}, controller.signal)).then(
        result => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: 'result', id: m.id, result })); },
        error => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: 'result', id: m.id, error: errorInfo(error) })); },
      ).finally(() => this.requests.delete(m.id));
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.abortAll('WORKSPACE_DISCONNECTED', '连接已断开，任务中止。');
      this.setConnection(this.enabled ? '未连接 · 检查 MCP 是否启动，正在重连' : '未连接');
      if (this.enabled) this.retry = setTimeout(() => this.connect(port), 3000);
    });
  }
  publish() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ kind: 'state', revision: this.commands.revision, name: this.getProject().name }));
  }
  busyReason() {
    if (this.busy) return this.busy === 'export' ? '正在导出画面或视频' : '正在渲染草案画面';
    return this.review ? '用户正在预览草案' : null;
  }
  // Wait for the page to be idle instead of failing at once: the agent cannot do
  // anything useful with a bare "busy", and must not fall back to guessing with sleeps.
  async assertIdle(label) {
    const started = Date.now();
    let reason = this.busyReason();
    while (reason && Date.now() - started < BUSY_WAIT) {
      await new Promise(resolve => setTimeout(resolve, 200));
      reason = this.busyReason();
    }
    if (reason) {
      refuse('WORKSPACE_BUSY', `工作台${reason}，已等待 ${Math.round((Date.now() - started) / 1000)} 秒仍未空闲，${label} 没有执行，项目未被修改。请结束该操作后重试，不要用 sleep 猜测。`,
        { retryAfterMs: 20000 });
    }
    this.assertReady();
  }
  // Claims the renderer in the same synchronous step that sees it idle, so two
  // concurrent requests cannot both pass the check.
  async beginWork(label) {
    const started = Date.now();
    while (this.busyReason()) {
      if (Date.now() - started >= BUSY_WAIT) {
        refuse('WORKSPACE_BUSY', `工作台${this.busyReason()}，已等待 ${Math.round((Date.now() - started) / 1000)} 秒仍未空闲，${label} 没有执行，项目未被修改。请结束该操作后重试，不要用 sleep 猜测。`,
          { retryAfterMs: 20000 });
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    this.assertReady(); this.busy = label; this.updateUI();
  }
  coverageKey(draftId, version) { return `${draftId}:${version}`; }
  recordFrames(draftId, version, frames) {
    const key = this.coverageKey(draftId, version), seen = this.seen.get(key) || new Map();
    for (const frame of frames) {
      const times = seen.get(frame.shotId) || new Set();
      times.add(frame.progress); seen.set(frame.shotId, times);
    }
    this.seen.set(key, seen);
    if (this.seen.size > 40) this.seen.delete(this.seen.keys().next().value);
  }
  frameCoverage(project, draftId, version) {
    const seen = this.seen.get(this.coverageKey(draftId, version)) || new Map();
    return project.shots.map(shot => {
      const required = requiredTimes(project, shot);
      const captured = [...(seen.get(shot.id) || [])].sort((a, b) => a - b);
      return { shotId: shot.id, requiredTimes: required, capturedTimes: captured, missingRequiredTimes: missingTimes(required, captured) };
    });
  }
  // Default batch covers whole shots rather than truncating mid-shot; the rest is
  // reported so the agent knows exactly what to ask for next.
  frameBatch(project, requested) {
    if (requested?.length) return { requests: requested, deferred: { count: 0, frames: [] } };
    const all = requiredFrames(project), batch = [];
    for (const shot of project.shots) {
      const shotFrames = all.filter(frame => frame.shotId === shot.id);
      if (batch.length + shotFrames.length > FRAME_LIMIT) break;
      batch.push(...shotFrames);
    }
    if (!batch.length) batch.push(...all.slice(0, FRAME_LIMIT));
    const remaining = all.filter(frame => !batch.includes(frame));
    return { requests: batch, deferred: { count: remaining.length, frames: remaining.slice(0, FRAME_LIMIT) } };
  }
  async withRenderer(label, fn) {
    await this.beginWork(label);
    try { return await fn(this.renderer()); } finally { this.busy = null; this.updateUI(); }
  }
  async dispatch(method, args, signal) {
    if (args.workspaceId !== this.commands.workspaceId) refuse('WORKSPACE_MISMATCH', '请求的工作区与当前页面不一致。');
    if (signal.aborted) refuse('CANCELLED', '请求已取消。');
    if (method === 'get_job') return this.describeJob(args.jobId);
    if (method === 'cancel_job') return this.cancelJob(args.jobId);
    this.assertReady();
    if (method === 'get_context') {
      const project = clone(this.getProject());
      return { workspaceId: this.commands.workspaceId, revision: this.commands.revision, project, spatialContext: this.spatialData(project, args.spatial || {}),
        previsPlan: previsPlan(project), drafts: this.commands.list(), activity: this.review ? 'review' : this.busy, limitations: CHECK_LIMITATIONS };
    }
    if (method === 'get_draft') return this.commands.describe(args.draftId);
    await this.assertIdle(method);
    if (method === 'create_project') return this.createEmpty(String(args.name ?? '').trim(), Boolean(args.replace));
    if (method === 'create_draft') return this.commands.create(args.label);
    if (method === 'update_draft') return this.commands.update(args.draftId, args.plan, args.expectedVersion);
    if (method === 'discard_draft') return this.commands.discard(args.draftId);
    if (method === 'submit_draft') {
      // A pass without looking at the required times is the failure mode this guards.
      const d = this.commands.describe(args.draftId), project = this.commands.candidate(args.draftId);
      const coverage = this.frameCoverage(project, d.id, d.version);
      const incomplete = coverage.filter(c => c.missingRequiredTimes.length);
      if (incomplete.length) {
        const detail = incomplete.map(c => `${c.shotId} 缺 t=${c.missingRequiredTimes.map(t => `${t}`).join('、')}`).join('；');
        refuse('MISSING_FRAMES', `提交前需要先看过每个镜头的必看时刻截图。还缺：${detail}。请用 render_frames 指定这些 progress 补拍后重试。`, { coverage });
      }
      const result = this.commands.submit(args.draftId, args.expectedVersion, args.summary, args.unresolved);
      this.toast('Agent 已提交预演草案，请在「Agent 草案」中预览与应用。'); return result;
    }
    if (method === 'check_draft' || method === 'render_frames') {
      const d = this.commands.describe(args.draftId), project = this.commands.candidate(d.id), bytes = this.getBytes();
      return this.withRenderer(method, async renderer => {
        if (method === 'check_draft') return this.commands.checked(d.id, d.version, await renderer.check(project, bytes, signal));
        const batch = this.frameBatch(project, args.frames);
        const result = await renderer.frames(project, bytes, batch.requests, signal, { view: args.view ?? 'auto' });
        this.commands.editable(d.id);
        this.recordFrames(d.id, d.version, result.frames);
        return { workspaceId: this.commands.workspaceId, draftId: d.id, draftVersion: d.version, baseRevision: d.baseRevision,
          ...result, deferred: batch.deferred, coverage: this.frameCoverage(project, d.id, d.version) };
      });
    }
    if (method === 'export_artifacts') return this.startExport(args);
    refuse('UNKNOWN_COMMAND', '不支持的操作；正式项目只能在网站审阅界面应用。');
  }
  async startExport(args) {
    await this.assertIdle('export_artifacts');
    let project, source, review;
    if (args.draftId) {
      const d = this.commands.describe(args.draftId); project = this.commands.candidate(d.id);
      source = { kind: 'draft', draftId: d.id, draftVersion: d.version, baseRevision: d.baseRevision };
      review = { summary: d.summary, unresolved: d.unresolved, checks: d.checks };
    } else {
      if (args.expectedRevision !== this.commands.revision) refuse('STALE_REVISION', '正式项目已改变，请重新读取后导出。');
      project = clone(this.getProject()); source = { kind: 'active', revision: this.commands.revision };
    }
    const id = crypto.randomUUID(), bytes = this.getBytes(), controller = new AbortController();
    for (const [oldId, oldJob] of this.jobs) if (this.jobs.size >= 5 && oldJob.status !== 'running') this.jobs.delete(oldId);
    const job = { id, workspaceId: this.commands.workspaceId, source, review, formats: args.formats, status: 'running', progress: 0, phase: '准备', createdAt: new Date().toISOString(), controller };
    this.jobs.set(id, job);
    // Busy is acquired synchronously, before returning the job identifier.
    void this.withRenderer('export', async renderer => {
      try {
        const files = await renderer.export(project, bytes, args.formats, { workspaceId: job.workspaceId, source, review }, controller.signal, (p, phase) => {
          job.progress = p; job.phase = phase || 'video'; this.updateJobs();
        });
        if (controller.signal.aborted) refuse('CANCELLED', '导出已取消。');
        job.files = files; job.status = 'completed'; job.progress = 1;
      } catch (error) {
        job.files = undefined; job.status = job.disconnectError ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed'; job.error = job.disconnectError || errorInfo(error);
      } finally { job.finishedAt = new Date().toISOString(); this.updateJobs(true); }
    }).catch(error => { job.status = 'failed'; job.error = errorInfo(error); this.updateJobs(true); });
    this.updateUI(); return this.describeJob(id);
  }
  describeJob(id) {
    const job = this.jobs.get(id); if (!job) refuse('JOB_NOT_FOUND', '导出任务不存在或已从当前页面清理。');
    const { controller, disconnectError, ...result } = job; return result;
  }
  cancelJob(id) {
    const job = this.jobs.get(id); if (!job) refuse('JOB_NOT_FOUND', '导出任务不存在。');
    if (job.status === 'running') { job.controller.abort(); job.status = 'cancelled'; job.error = { code: 'CANCELLED', message: '任务已取消，未交付部分文件。' }; this.updateJobs(true); }
    return this.describeJob(id);
  }
  abortAll(code, message) {
    for (const request of this.requests.values()) request.abort();
    for (const job of this.jobs.values()) if (job.status === 'running') { job.disconnectError = { code, message }; job.controller.abort(); job.status = 'failed'; job.error = job.disconnectError; }
    this.updateJobs(true);
  }
  async startReview(id) {
    await this.assertIdle('review'); this.pause();
    const d = this.commands.describe(id), project = this.commands.candidate(id);
    this.review = { id, version: d.version, project, time: 0, last: performance.now(), playing: false };
    this.updateUI();
    try {
      const renderer = this.renderer(); await renderer.prepare(project, this.getBytes());
      if (this.review?.id !== id) return;
      this.el('agent-drafts').hidden = true; this.el('agent-review').hidden = false;
      this.el('agent-review-name').textContent = `${d.label} · v${d.version}`;
      this.el('agent-review-summary').textContent = d.summary || '尚未提交。可以预览，完成检查并提交后才能应用。';
      this.el('agent-preview-monitor').append(renderer.view.film.domElement);
      this.el('agent-preview-time').max = totalDuration(project.shots); this.el('agent-preview-time').step = 1 / project.format.fps;
      this.el('agent-preview-play').disabled = !project.shots.length; this.el('agent-preview-play').textContent = '播放草案';
      this.el('agent-review-report').innerHTML = `<h4>检查与待审事项</h4>${(d.checks?.messages || []).map(m => `<p class="agent-issue"><strong>${escape(m.shotId)}</strong> · ${escape(m.time ?? '约束')} · ${escape(m.message)}</p>`).join('') || '<p class="field-help">尚无检查问题记录；仍需逐镜审阅。</p>'}${d.unresolved.map(x => `<p class="agent-issue">待审：${escape(x)}</p>`).join('')}<details><summary>检查覆盖范围</summary>${CHECK_LIMITATIONS.map(x => `<p class="field-help">${escape(x)}</p>`).join('')}</details>`;
      const tick = now => {
        if (!this.review || this.review.id !== id) return;
        const r = this.review, total = totalDuration(r.project.shots);
        if (r.playing && !document.hidden) r.time = Math.min(total, r.time + (now - r.last) / 1000);
        r.last = now;
        if (r.time >= total) { r.playing = false; this.el('agent-preview-play').textContent = '播放草案'; }
        const shot = renderer.atTime(r.project, r.time);
        this.el('agent-preview-time').value = r.time; this.el('agent-preview-label').textContent = `${r.time.toFixed(1)} / ${total.toFixed(1)}s · ${shot?.shot.title || '无镜头'}`;
        this.previewFrame = requestAnimationFrame(tick);
      };
      this.previewFrame = requestAnimationFrame(tick); this.updateUI();
    } catch (error) { this.endReview(); throw error; }
  }
  endReview() {
    cancelAnimationFrame(this.previewFrame); this.review = null;
    if (this.renderEngine) this.renderEngine.monitor.append(this.renderEngine.view.film.domElement);
    this.el('agent-review').hidden = true; this.el('agent-drafts').hidden = false; this.updateUI();
  }
  updateUI() {
    if (!this.dialog) return;
    const drafts = this.commands.list(), count = drafts.filter(d => d.status === 'submitted' && !d.stale).length;
    document.getElementById('agent-count').textContent = count ? String(count) : '';
    this.el('agent-connect').textContent = this.enabled ? '断开连接' : '连接本机 Agent'; this.el('agent-port').disabled = this.enabled;
    this.el('agent-connection-state').textContent = this.connectionText;
    this.el('agent-workspace-id').textContent = `工作区 ${this.commands.workspaceId} · 版本 ${this.commands.sequence}`;
    if (!this.review) this.el('agent-drafts').innerHTML = drafts.length ? drafts.map(d => `<article class="agent-draft-card"><div><h3>${escape(d.label)}</h3><p class="field-help">v${d.version} · ${d.shotCount} 个镜头 · ${d.stale && d.status !== 'applied' ? '项目已改变，请重新生成' : statusName[d.status]}${d.issueCount == null ? ' · 尚未检查' : ` · ${d.issueCount} 项提示`}</p></div><div class="form-actions"><button data-review="${d.id}" ${this.busy || d.stale || d.status === 'applied' ? 'disabled' : ''}>预览与审阅</button><button data-discard="${d.id}" ${this.busy ? 'disabled' : ''}>丢弃</button></div></article>`).join('') : '<div class="agent-empty"><strong>等待第一份预演草案</strong><p>连接后，在外部 Agent 中描述这段戏的意图。候选方案将在这里供你审阅。</p></div>';
    if (this.review) {
      const d = this.commands.describe(this.review.id), canApply = !d.stale && d.status === 'submitted' && d.version === this.review.version && d.checkedVersion === d.version;
      this.el('agent-apply').disabled = !canApply;
      this.el('agent-review-state').textContent = d.stale ? '项目已改变，请重新生成草案。' : canApply ? '只读预览 · 确认后整套应用，可撤销。' : '只读预览 · 需要 Agent 完成检查并提交。';
    }
    this.updateJobs(true);
  }
  updateJobs(force = false) {
    if (!this.dialog || (!force && performance.now() - (this.lastJobUI || 0) < 300)) return;
    this.lastJobUI = performance.now();
    this.el('agent-jobs').innerHTML = [...this.jobs.values()].reverse().map(job => `<article class="agent-job"><div><strong>${statusName[job.status]} · ${escape(job.phase)}</strong><p class="field-help">${escape(job.id)}${job.error ? ` · ${escape(job.error.message)}` : ''}</p></div><progress aria-label="导出进度" value="${job.progress}" max="1"></progress>${job.status === 'running' ? `<button data-cancel-job="${job.id}">取消导出</button>` : ''}</article>`).join('');
  }
}
