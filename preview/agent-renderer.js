import { SceneView } from './scene.js';
import { cameraPlan, sampledTimeline, shotAt, totalDuration } from './core.mjs';
import { toBase64 } from './storage.mjs';
import { zipSync, strToU8 } from '../vendor/libs/fflate.module.js';
import { CHECK_LIMITATIONS, refuse } from './commands.mjs';

const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));
const aborted = signal => { if (signal?.aborted) refuse('CANCELLED', '任务已取消。'); };
const png = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画面导出失败。')), 'image/png'));
const safe = value => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 65);
// Contact sheets: one 1280-wide image of 320x180 tiles instead of N full frames.
const SHEET_COLUMNS = 4, SHEET_TILE = [320, 180];
async function file(name, value, mimeType = 'application/json') {
  const blob = value instanceof Blob ? value : new Blob([value instanceof Uint8Array || typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type: mimeType });
  return { name, mimeType: blob.type || mimeType, data: await toBase64(await blob.arrayBuffer()) };
}

// A separate Three.js scene and canvas: draft images/exports never borrow the
// editable project's render state, actors, animation clock or history.
export class AgentRenderer {
  constructor() {
    this.container = document.createElement('div'); this.container.className = 'agent-render-sandbox'; this.container.setAttribute('aria-hidden', 'true');
    this.stage = document.createElement('div'); this.monitor = document.createElement('div'); this.stage.style.cssText = 'width:640px;height:360px';
    this.container.append(this.stage, this.monitor); document.body.append(this.container);
    this.view = new SceneView(this.stage, this.monitor, { select() {}, addAnchor() {}, dragStart() {}, drag() {}, dragEnd() {} });
    this.view.transform.enabled = false; this.bytes = null;
  }
  async prepare(project, bytes, signal) {
    aborted(signal);
    if (this.bytes !== bytes) {
      const parsed = await this.view.parseModel(bytes); aborted(signal);
      this.view.installModel(parsed, project); this.bytes = bytes;
    } else this.view.calibrate(project);
    this.view.buildActors(project); aborted(signal);
  }
  frame(project, shot, progress) {
    const camera = project.cameras.find(c => c.id === shot.cameraId);
    this.view.render(project, camera, shot, progress);
  }
  atTime(project, time) {
    const active = shotAt(project.shots, time);
    if (active) this.frame(project, active.shot, active.progress);
    return active;
  }
  async check(project, bytes, signal) {
    await this.prepare(project, bytes, signal); await yieldFrame(); aborted(signal);
    return this.view.validate(project);
  }
  sheetCanvas(count) {
    const canvas = document.createElement('canvas');
    canvas.width = SHEET_COLUMNS * SHEET_TILE[0];
    canvas.height = Math.ceil(count / SHEET_COLUMNS) * SHEET_TILE[1];
    return canvas;
  }
  drawSheetTile(context, index, label) {
    const [width, height] = SHEET_TILE, x = (index % SHEET_COLUMNS) * width, y = Math.floor(index / SHEET_COLUMNS) * height;
    context.drawImage(this.view.film.domElement, x, y, width, height);
    context.fillStyle = 'rgba(12,18,24,.80)'; context.fillRect(x, y + height - 24, width, 24);
    context.fillStyle = '#e9f1f3'; context.font = '500 15px "Microsoft YaHei", sans-serif'; context.textBaseline = 'middle';
    context.fillText(label, x + 8, y + height - 12, width - 16);
  }
  async frames(project, bytes, requests, signal, options = {}) {
    if (!project.shots.length) refuse('NO_SHOTS', '草案没有镜头。');
    requests ||= [0, .5, 1].map(progress => ({ shotId: project.shots[0].id, progress }));
    if (requests.length < 1 || requests.length > 12) refuse('FRAME_LIMIT', '每次读取 1–12 帧，请分批审阅。');
    const resolved = requests.map(r => {
      const shot = project.shots.find(s => s.id === r.shotId);
      if (!shot || !Number.isFinite(r.progress) || r.progress < 0 || r.progress > 1) refuse('INVALID_FRAME', '镜头不存在或 progress 不在 0–1 内。');
      return { ...r, shot };
    });
    await this.prepare(project, bytes, signal);
    // Every frame is still rendered and saved: those are the real evidence. The sheet
    // is only the cheap first look the tool hands back instead of a dozen images.
    const view = ['auto', 'sheet', 'frames'].includes(options.view) ? options.view : 'auto';
    const wantSheet = view === 'sheet' || (view === 'auto' && resolved.length > 1);
    const files = [], frames = [], sheets = [];
    const canvas = wantSheet ? this.sheetCanvas(resolved.length) : null, context = canvas?.getContext('2d');
    for (const [index, r] of resolved.entries()) {
      aborted(signal); this.frame(project, r.shot, r.progress);
      const name = `${String(index + 1).padStart(2, '0')}_${safe(r.shotId)}_${r.progress}.png`;
      files.push(await file(name, await png(this.view.film.domElement), 'image/png'));
      frames.push({ shotId: r.shotId, progress: r.progress, timeSeconds: r.progress * r.shot.duration, name });
      if (context) this.drawSheetTile(context, index, `${r.shotId} · t=${r.progress}`);
      await yieldFrame();
    }
    if (canvas) {
      const name = 'contact-sheet.png';
      files.push(await file(name, await png(canvas), 'image/png'));
      sheets.push({ name, tiles: canvas.height / SHEET_TILE[1], times: frames.map(f => ({ shotId: f.shotId, progress: f.progress })),
        frameNames: frames.map(f => f.name) });
    }
    aborted(signal); return { frames, files, sheets };
  }
  async video(project, signal, progress) {
    aborted(signal);
    if (document.hidden) refuse('PAGE_HIDDEN', '录制需要保持 PrevizCam 页面可见。');
    const duration = totalDuration(project.shots);
    if (!duration || duration > 300) refuse('VIDEO_DURATION', '视频需要非空时间轴，且每次不超过 5 分钟。');
    if (!globalThis.MediaRecorder || !this.view.film.domElement.captureStream) refuse('VIDEO_UNSUPPORTED', '浏览器不支持 WebM 录制。');
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    if (!mimeType) refuse('VIDEO_UNSUPPORTED', '浏览器没有可用的 WebM 编码器。');
    this.atTime(project, 0);
    const stream = this.view.film.domElement.captureStream(project.format.fps), recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
    const videoTrack = stream.getVideoTracks()[0];
    return new Promise((resolve, reject) => {
      const chunks = []; let reason, frameId, finished = false;
      const cleanup = () => { cancelAnimationFrame(frameId); clearTimeout(deadline); stream.getTracks().forEach(t => t.stop()); signal?.removeEventListener('abort', cancel); document.removeEventListener('visibilitychange', visibility); };
      const stop = error => {
        if (finished) return; reason ||= error;
        if (recorder.state !== 'inactive') recorder.stop();
        else { finished = true; cleanup(); reject(reason || new Error('录制未启动。')); }
      };
      const cancel = () => stop(Object.assign(new Error('录制已取消，未交付部分视频。'), { code: 'CANCELLED' }));
      const visibility = () => { if (document.hidden) stop(Object.assign(new Error('页面进入后台，录制已中止。'), { code: 'PAGE_HIDDEN' })); };
      const deadline = setTimeout(() => stop(Object.assign(new Error('录制超时，未交付部分视频。'), { code: 'VIDEO_TIMEOUT' })), duration * 1000 + 15000);
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => stop(Object.assign(new Error('浏览器视频编码失败。'), { code: 'VIDEO_ENCODING' }));
      recorder.onstop = () => {
        if (finished) return; finished = true; cleanup();
        if (reason) reject(reason); else if (!chunks.length) reject(new Error('录制没有产生视频。')); else resolve(new Blob(chunks, { type: mimeType }));
      };
      signal?.addEventListener('abort', cancel, { once: true }); document.addEventListener('visibilitychange', visibility);
      const started = performance.now();
      const tick = now => {
        if (finished || recorder.state !== 'recording') return;
        try {
          const time = Math.min(duration, (now - started) / 1000); this.atTime(project, time);
          // Offscreen WebGL canvases are not always composited. Explicit capture
          // keeps recording independent of whether the draft preview is visible.
          videoTrack.requestFrame?.(); progress(time / duration);
          if (time >= duration) recorder.stop(); else frameId = requestAnimationFrame(tick);
        } catch (error) { stop(error); }
      };
      try { recorder.start(250); this.atTime(project, 0); videoTrack.requestFrame?.(); frameId = requestAnimationFrame(tick); } catch (error) { stop(error); }
    });
  }
  async export(project, bytes, formats, metadata, signal, progress) {
    const allowed = ['project', 'storyboard', 'timeline', 'report', 'video'];
    if (!formats.length || formats.some(f => !allowed.includes(f))) refuse('INVALID_FORMAT', '导出格式无效。');
    formats = [...new Set(formats)];
    if (formats.includes('storyboard') && project.shots.length > 100) refuse('SHOT_LIMIT', '分镜包最多 100 个镜头，请分段导出。');
    await this.prepare(project, bytes, signal);
    const files = [], messages = this.view.validate(project), report = { type: 'previzcam.review-report', version: 1, ...metadata,
      messages, limitations: CHECK_LIMITATIONS, generatedAt: new Date().toISOString() };
    for (const [index, format] of formats.entries()) {
      aborted(signal); progress(index / formats.length, format);
      if (format === 'project') {
        const bundle = structuredClone(project);
        if (bundle.scene.source === 'embedded') bundle.embeddedModel = { mimeType: 'model/gltf-binary', base64: await toBase64(bytes) };
        files.push(await file('previzcam-project.json', bundle));
      } else if (format === 'timeline') {
        files.push(await file('camera-plan.json', cameraPlan(project)), await file('camera-timeline.json', sampledTimeline(project)));
      } else if (format === 'report') files.push(await file('review-report.json', report));
      else if (format === 'storyboard') {
        const entries = { 'camera-plan.json': strToU8(JSON.stringify(cameraPlan(project))), 'shots.json': strToU8(JSON.stringify(project.shots)), 'review-report.json': strToU8(JSON.stringify(report)) };
        for (const [shotIndex, shot] of project.shots.entries()) {
          for (const [label, t] of [['start', 0], ['middle', .5], ['end', 1]]) {
            aborted(signal); this.frame(project, shot, t);
            entries[`${String(shotIndex + 1).padStart(2, '0')}_${safe(shot.id)}_${label}.png`] = new Uint8Array(await (await png(this.view.film.domElement)).arrayBuffer());
            await yieldFrame();
          }
          progress((index + (shotIndex + 1) / project.shots.length) / formats.length, format);
        }
        files.push(await file('previzcam-storyboards.zip', zipSync(entries, { level: 0 }), 'application/zip'));
      } else if (format === 'video') files.push(await file('previzcam-preview.webm', await this.video(project, signal, p => progress((index + p) / formats.length, format)), 'video/webm'));
      await yieldFrame();
    }
    aborted(signal); return files;
  }
}
