import { clone, validateProject, materialList } from './core.mjs';

export class CommandError extends Error {
  constructor(code, message, details) { super(message); this.name = 'CommandError'; this.code = code; this.details = details; }
}
export const refuse = (code, message, details) => { throw new CommandError(code, message, details); };
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function editProject(project, change) {
  const next = clone(project); change(next); validateProject(next); return next;
}
export function previsPlan(project) {
  return { type: 'previzcam.previs-plan', version: 1, sceneId: project.scene.id,
    script: clone(project.script), actors: clone(project.actors), cameras: clone(project.cameras), shots: clone(project.shots) };
}
export function applyPrevisPlan(project, plan) {
  if (!plan || plan.type !== 'previzcam.previs-plan' || plan.version !== 1) refuse('INVALID_PLAN', '需要 previzcam.previs-plan version: 1。');
  if (plan.sceneId !== project.scene.id) refuse('SCENE_MISMATCH', '草案必须使用当前已加载的场景。');
  const fields = ['type', 'version', 'sceneId', 'script', 'actors', 'cameras', 'shots'];
  if (Object.keys(plan).some(key => !fields.includes(key)) || fields.some(key => !(key in plan))) refuse('INVALID_PLAN', '方案仅包含 type、version、sceneId、script、actors、cameras、shots，且必须全部提供。');
  const next = editProject(project, p => {
    for (const key of ['script', 'actors', 'cameras', 'shots']) p[key] = clone(plan[key]);
  });
  if (!next.script) refuse('INVALID_PLAN', '预演草案需要结构化剧本。');
  const materials = materialList(next.script);
  for (const camera of project.cameras.filter(c => c.locked)) {
    const candidate = next.cameras.find(c => c.id === camera.id);
    if (!candidate || canonical(candidate) !== canonical(camera)) refuse('LOCKED_CAMERA', `锁定相机「${camera.name}」必须保留原值。`);
  }
  const actors = new Set(next.actors.map(a => a.id));
  for (const shot of next.shots) {
    if (shot.cast.some(id => !actors.has(id))) refuse('MISSING_ACTOR', `镜头 ${shot.id} 引用了缺少占位的人物。`);
    if (Object.keys(shot.blocking).some(id => !shot.cast.includes(id))) refuse('INVALID_BLOCKING', `镜头 ${shot.id} 的走位人物需要出现在 cast 中。`);
    const original = project.shots.find(s => s.id === shot.id);
    const material = materials.find(m => m.id === (shot.sourceId || shot.id));
    const staticRequired = original?.motionPolicy === 'static' || material?.motionPolicy === 'static' || Boolean(next.script.cameraPolicy);
    if ((staticRequired && shot.motionPolicy !== 'static') || ((staticRequired || shot.motionPolicy === 'static') && next.cameras.find(c => c.id === shot.cameraId).mode !== 'static')) {
      refuse('MOTION_POLICY', `镜头 ${shot.id} 要求固定机位；请保留 static 约束并使用静止相机。`);
    }
  }
  return next;
}

export const CHECK_LIMITATIONS = [
  '每镜最多 301 个离散采样时刻，并检查相邻相机位置间的相交；不是连续无碰撞保证。',
  '空间分组包围盒描述范围，不等于实心障碍；内部判定只覆盖命名规则匹配的墙、柱等结构。',
  '未检查人物相互遮挡、肢体或走位碰撞、对白时长、真实景深和精细表演。',
  '轴线、动作接续和叙事构图需要结合实际画面审阅。',
];

// The browser owns active state. MCP can only write independent drafts; accept()
// is called by the local review UI and is deliberately absent from the tool map.
export class ProjectCommands {
  constructor({ getProject, applyProject, onChange = () => {}, workspaceId = crypto.randomUUID() }) {
    this.getProject = getProject; this.applyProject = applyProject; this.onChange = onChange;
    this.workspaceId = workspaceId; this.generation = crypto.randomUUID(); this.sequence = 0; this.drafts = new Map();
  }
  get revision() { return `${this.generation}:${this.sequence}`; }
  changed() { this.sequence++; this.onChange(); }
  draft(id) { const d = this.drafts.get(id); if (!d) refuse('DRAFT_NOT_FOUND', '草案不存在或页面已重新打开。'); return d; }
  editable(id) {
    const d = this.draft(id);
    if (d.status === 'applied') refuse('DRAFT_APPLIED', '该草案已经应用；请从当前项目创建新草案。');
    if (d.baseRevision !== this.revision) refuse('STALE_DRAFT', '项目已改变。请读取当前项目并创建新草案，不能覆盖后续编辑。');
    return d;
  }
  describe(id) {
    const d = this.draft(id), { baseProject, ...rest } = d;
    return clone({ ...rest, stale: d.baseRevision !== this.revision, currentRevision: this.revision });
  }
  list() { return [...this.drafts.keys()].map(id => { const { plan, checks, ...d } = this.describe(id); return { ...d, shotCount: plan.shots.length, issueCount: checks?.messages.length ?? null }; }); }
  create(label = 'Agent 预演草案') {
    if (this.drafts.size >= 20) refuse('DRAFT_LIMIT', '当前页面最多保留 20 份草案，请先丢弃不需要的草案。');
    const baseProject = clone(this.getProject()), id = crypto.randomUUID();
    this.drafts.set(id, { id, label: String(label).slice(0, 160), baseRevision: this.revision, version: 1,
      baseProject, plan: previsPlan(baseProject), status: 'editing', checks: null, checkedVersion: null,
      summary: '', unresolved: [], createdAt: new Date().toISOString() });
    this.onChange(); return this.describe(id);
  }
  update(id, plan, expectedVersion) {
    const d = this.editable(id);
    if (d.version !== expectedVersion) refuse('DRAFT_CONFLICT', '草案版本已变化，请先重新读取。');
    applyPrevisPlan(d.baseProject, plan);
    d.plan = clone(plan); d.version++; d.status = 'editing'; d.checkedVersion = null; d.checks = null; d.summary = ''; d.unresolved = [];
    this.onChange(); return this.describe(id);
  }
  candidate(id) { const d = this.editable(id); return applyPrevisPlan(d.baseProject, d.plan); }
  checked(id, version, messages) {
    const d = this.editable(id);
    if (d.version !== version) refuse('DRAFT_CONFLICT', '检查期间草案已变化，请重新检查。');
    d.checks = { messages: clone(messages), limitations: CHECK_LIMITATIONS, checkedAt: new Date().toISOString(), draftVersion: version };
    d.checkedVersion = version; this.onChange(); return this.describe(id);
  }
  submit(id, expectedVersion, summary, unresolved = []) {
    const d = this.editable(id);
    if (d.version !== expectedVersion || d.checkedVersion !== d.version) refuse('CHECK_REQUIRED', '请对当前草案版本执行 check_draft 后再提交。');
    this.candidate(id);
    d.status = 'submitted'; d.summary = String(summary).slice(0, 5000); d.unresolved = unresolved.map(x => String(x).slice(0, 1000)).slice(0, 50);
    this.onChange(); return this.describe(id);
  }
  accept(id, expectedVersion) {
    const d = this.editable(id);
    if (d.status !== 'submitted' || d.version !== expectedVersion || d.checkedVersion !== d.version) refuse('CHECK_REQUIRED', '当前版本尚未完成检查与提交。');
    const next = this.candidate(id);
    this.applyProject(next); // One user action, one history entry. Calls changed().
    d.status = 'applied'; d.appliedRevision = this.revision; this.onChange(); return this.describe(id);
  }
  discard(id) { this.draft(id); this.drafts.delete(id); this.onChange(); return { discarded: id }; }
}
