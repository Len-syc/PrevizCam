import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const failure = (code, message) => Object.assign(new Error(message), { code });
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
export class BrowserBridge {
  constructor({ port = 8900, origins = ['http://127.0.0.1:8899'], timeout = 45000, onDisconnect = () => {} } = {}) {
    this.port = port; this.origins = new Set(origins); this.timeout = timeout; this.onDisconnect = onDisconnect;
    this.workspaces = new Map(); this.pending = new Map();
  }
  async start() {
    this.http = createServer((req, res) => { res.writeHead(404); res.end('PrevizCam browser bridge'); });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 210 * 1024 * 1024, perMessageDeflate: false });
    this.http.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bridge' || !this.origins.has(req.headers.origin) || ![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(req.headers.host)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.attach(ws));
    });
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, '127.0.0.1', () => { this.http.off('error', reject); this.port = this.http.address().port; resolve(); });
    });
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    }, 20000); this.heartbeat.unref();
    return this;
  }
  attach(ws) {
    ws.alive = true; ws.on('pong', () => { ws.alive = true; }); ws.on('error', () => {});
    const handshake = setTimeout(() => ws.close(1008, 'Handshake required'), 5000); handshake.unref();
    ws.on('message', data => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
      if (m.kind === 'hello' && !ws.workspaceId) {
        if (m.protocol !== 1 || !idPattern.test(m.workspaceId) || typeof m.revision !== 'string' || typeof m.name !== 'string' || this.workspaces.has(m.workspaceId)) { ws.close(1008, 'Invalid or duplicate workspace'); return; }
        clearTimeout(handshake); ws.workspaceId = m.workspaceId;
        this.workspaces.set(m.workspaceId, { ws, workspaceId: m.workspaceId, name: m.name.slice(0, 500), revision: m.revision.slice(0, 150) });
        ws.send(JSON.stringify({ kind: 'connected', protocol: 1, workspaceId: m.workspaceId })); return;
      }
      if (!ws.workspaceId) { ws.close(1008, 'Handshake required'); return; }
      if (m.kind === 'state') {
        const w = this.workspaces.get(ws.workspaceId);
        if (typeof m.name === 'string') w.name = m.name.slice(0, 500);
        if (typeof m.revision === 'string') w.revision = m.revision.slice(0, 150);
      } else if (m.kind === 'result') {
        const pending = this.pending.get(m.id);
        if (!pending || pending.ws !== ws) return;
        clearTimeout(pending.timer); this.pending.delete(m.id);
        if (m.error) {
          const error = failure(String(m.error.code || 'BROWSER_ERROR'), String(m.error.message || 'Browser command failed'));
          // Keep the machine-readable reason so the MCP side can wait and retry instead of guessing.
          if (Number.isFinite(Number(m.error.retryAfterMs))) error.retryAfterMs = Number(m.error.retryAfterMs);
          if (m.error.details) error.details = m.error.details;
          pending.reject(error);
        } else pending.resolve(m.result);
      }
    });
    ws.on('close', () => {
      clearTimeout(handshake);
      if (this.workspaces.get(ws.workspaceId)?.ws === ws) { this.workspaces.delete(ws.workspaceId); this.onDisconnect(ws.workspaceId); }
      for (const [id, p] of this.pending) if (p.ws === ws) {
        clearTimeout(p.timer); this.pending.delete(id); p.reject(failure('WORKSPACE_DISCONNECTED', '网站已断开；请求未完成，请重新连接后读取当前状态。'));
      }
    });
  }
  list() { return [...this.workspaces.values()].map(({ ws, ...w }) => w); }
  call(workspaceId, method, args = {}) {
    const w = this.workspaces.get(workspaceId);
    if (!w || w.ws.readyState !== WebSocket.OPEN) return Promise.reject(failure('WORKSPACE_NOT_FOUND', '工作区未连接。请在网站的 Agent 草案面板连接，再调用 list_workspaces。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(failure('REQUEST_TIMEOUT', '网站响应超时。请读取当前状态后决定是否重试；不要盲目重复写入。'));
        if (w.ws.readyState === WebSocket.OPEN) w.ws.send(JSON.stringify({ kind: 'cancelRequest', id }));
      }, this.timeout);
      this.pending.set(id, { ws: w.ws, timer, resolve, reject });
      w.ws.send(JSON.stringify({ kind: 'request', id, method, args }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(failure('WORKSPACE_DISCONNECTED', error.message)); }
      });
    });
  }
  async close() {
    clearInterval(this.heartbeat);
    for (const ws of this.wss?.clients || []) ws.terminate();
    await Promise.all([
      this.wss && new Promise(resolve => this.wss.close(resolve)),
      this.http?.listening && new Promise(resolve => this.http.close(resolve)),
    ]);
  }
}
