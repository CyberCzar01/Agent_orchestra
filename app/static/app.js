'use strict';

const TOKEN = document.querySelector('meta[name="token"]').content;
const $ = (s, r = document) => r.querySelector(s);
const NODE_W = 210;
const DRAFT_KEY = 'agent-builder:draft';
const ALL_TOOLS = TOOL_GROUPS.flatMap(([, ts]) => ts.map(([t]) => t));
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const MODEL_SHORT = { '': 'модель сессии', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };

let env = { userAgentsDirExists: true, projects: [], skills: [], systems: [] };
let S = emptySystem();
let view = { x: 80, y: 60, k: 1 };
let sel = null;          // {type:'node', id} | {type:'edge', from, to}
let tab = 'settings';
let dirty = false;
let drag = null;
let viewTouched = false;   // пока холст не двигали руками, он подстраивается под окно
const heights = {};
const ROW_GAP = 175;

const canvas = $('#canvas');
const world = $('#world');

// ---------- утилиты ----------

function uid() { return Math.random().toString(36).slice(2, 10); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`;
}
function toggleIn(arr, v, on) { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }
function toggleSet(set, v, on) { on ? set.add(v) : set.delete(v); }

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'selected', 'disabled', 'open'].includes(k)) e[k] = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Конструктор выключен: им давно не пользовались или его закрыли. Запустите его значком Agent Builder, черновик сохранён.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (data.reload) {
    // Сервер обновился или перезапустился: черновик уже на диске, просто перезагружаемся.
    if (!reloading) {
      reloading = true;
      toast(data.error);
      flushDraft();
      setTimeout(() => location.reload(), 1500);
    }
    throw new Error(data.error);
  }
  if (res.status === 404 && path.startsWith('/api/')) {
    throw new Error('Запущена старая версия конструктора. Закройте Agent Builder (⌘Q) и откройте снова.');
  }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}
let reloading = false;

function toast(text, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, text);
  $('#toast-root').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Скопировано'); }
  catch { toast('Не удалось скопировать', 'err'); }
}

// ---------- модель ----------

function emptySystem(target) {
  return {
    version: 1, id: uid(), name: 'Новая система',
    target: target ? clone(target) : { scope: 'user', path: '' },
    entry: null, entryInSettings: false, nodes: [], edges: [],
  };
}

function normCfg(c) {
  return Object.assign({
    name: 'agent', description: '', model: '', effort: '', permissionMode: '',
    toolsMode: 'list', tools: [], extraTools: '', maxTurns: '', memory: '', skills: [],
    color: 'blue', prompt: '', teamSection: true, extraYaml: '',
  }, c || {});
}

function normSystem(s) {
  const out = Object.assign(emptySystem(), s || {});
  out.target = Object.assign({ scope: 'user', path: '' }, out.target || {});
  out.nodes = (out.nodes || []).map(n => ({
    id: n.id || uid(), role: n.role || 'custom', x: +n.x || 0, y: +n.y || 0, cfg: normCfg(n.cfg),
  }));
  const ids = new Set(out.nodes.map(n => n.id));
  out.edges = (out.edges || []).filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  if (!ids.has(out.entry)) out.entry = null;
  return out;
}

const byId = id => S.nodes.find(n => n.id === id);
const kidsOf = id => S.edges.filter(e => e.from === id).map(e => byId(e.to)).filter(Boolean);
const parentsOf = id => S.edges.filter(e => e.to === id).map(e => byId(e.from)).filter(Boolean);
const findEdge = (from, to) => S.edges.find(e => e.from === from && e.to === to);
function roots() { const has = new Set(S.edges.map(e => e.to)); return S.nodes.filter(n => !has.has(n.id)); }

function hasCycle() {
  const st = {};
  const visit = id => {
    if (st[id] === 1) return true;
    if (st[id] === 2) return false;
    st[id] = 1;
    for (const k of kidsOf(id)) if (visit(k.id)) return true;
    st[id] = 2;
    return false;
  };
  return S.nodes.some(n => visit(n.id));
}

function maxDepth(id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  let d = 0;
  for (const k of kidsOf(id)) d = Math.max(d, 1 + maxDepth(k.id, new Set(seen)));
  return d;
}

function reachable(id) {
  const out = new Set([id]), q = [id];
  while (q.length) for (const k of kidsOf(q.shift())) if (!out.has(k.id)) { out.add(k.id); q.push(k.id); }
  return out;
}

// ---------- имена ----------

const TR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugName(s, final = false) {
  let r = String(s || '').toLowerCase().split('').map(c => TR[c] ?? c).join('')
    .replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+/, '');
  if (final) r = r.replace(/-+$/, '');
  return r.slice(0, 63);
}

function uniqueName(base, exceptId, nodes = S.nodes) {
  base = slugName(base, true) || 'agent';
  const taken = new Set(nodes.filter(n => n.id !== exceptId).map(n => n.cfg.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function pickColor(pref, nodes = S.nodes) {
  const used = new Set(nodes.map(n => n.cfg.color));
  if (!used.has(pref)) return pref;
  return COLORS.find(c => !used.has(c)) || pref;
}

// ---------- генерация файла агента ----------

function yq(s) {
  const risky = s === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /:\s|\s#|:$|\s$/.test(s)
    || /^(true|false|null|yes|no|on|off|~|[-+]?[\d.]+)$/i.test(s);
  return risky ? JSON.stringify(s) : s;
}

function toolsOf(n) {
  const c = n.cfg;
  if (c.toolsMode === 'inherit') return null;
  const list = [...c.tools];
  for (const t of c.extraTools.split(',').map(x => x.trim()).filter(Boolean)) if (!list.includes(t)) list.push(t);
  const kids = kidsOf(n.id).map(k => k.cfg.name);
  if (kids.length) list.push(`Agent(${kids.join(', ')})`);
  return list.length ? list.join(', ') : null;
}

function teamBlock(n) {
  if (!n.cfg.teamSection) return '';
  const kids = kidsOf(n.id), parents = parentsOf(n.id);
  if (!kids.length && !parents.length) return '';
  const out = ['<!-- agent-builder:team -->'];
  if (kids.length) {
    out.push('## Команда', '',
      'Поручай работу этим агентам через инструмент Agent, других агентов не вызывай. Порядок в списке подсказывает порядок работы.', '');
    kids.forEach((k, i) => out.push(`${i + 1}. \`${k.cfg.name}\`: ${oneLine(k.cfg.description) || 'описание не задано'}`));
  }
  if (parents.length) {
    if (kids.length) out.push('');
    const names = parents.map(p => `\`${p.cfg.name}\``).join(', ');
    out.push('## Кому ты отчитываешься', '',
      `Задачи тебе ставит ${names}. Твой финальный ответ вернётся вызвавшему агенту, а не пользователю: пиши отчёт так, чтобы по нему можно было сразу принять решение.`);
  }
  out.push('<!-- /agent-builder:team -->');
  return out.join('\n');
}

function buildMd(n) {
  const c = n.cfg;
  const L = ['---', `name: ${c.name}`, `description: ${yq(oneLine(c.description) || c.name)}`];
  const tools = toolsOf(n);
  if (tools) L.push(`tools: ${tools}`);
  if (c.model) L.push(`model: ${c.model}`);
  if (c.effort) L.push(`effort: ${c.effort}`);
  if (c.permissionMode) L.push(`permissionMode: ${c.permissionMode}`);
  if (c.maxTurns) L.push(`maxTurns: ${c.maxTurns}`);
  if (c.memory) L.push(`memory: ${c.memory}`);
  if (c.skills.length) { L.push('skills:'); c.skills.forEach(s => L.push(`  - ${s}`)); }
  if (c.color) L.push(`color: ${c.color}`);
  if (c.extraYaml.trim()) L.push(c.extraYaml.trim());
  L.push('---', '');
  return L.join('\n') + [c.prompt.trim(), teamBlock(n)].filter(Boolean).join('\n\n') + '\n';
}

function targetDir() {
  return S.target.scope === 'project'
    ? `${(S.target.path || '<папка проекта>').replace(/\/+$/, '')}/.claude/agents`
    : '~/.claude/agents';
}

// ---------- проверка ----------

function validate() {
  const out = [];
  if (!S.nodes.length) return [{ level: 'info', text: 'Добавьте агентов слева или откройте шаблон.' }];
  const seen = new Set();
  for (const n of S.nodes) {
    const c = n.cfg, nm = c.name || 'без имени';
    if (!c.name) out.push({ level: 'err', node: n.id, text: 'У агента нет имени.' });
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(c.name)) out.push({ level: 'err', node: n.id, text: `Имя «${c.name}»: допустимы латиница, цифры и дефис.` });
    else if (seen.has(c.name)) out.push({ level: 'err', node: n.id, text: `Имя «${c.name}» уже занято другим агентом.` });
    seen.add(c.name);
    if (!oneLine(c.description)) out.push({ level: 'warn', node: n.id, text: `${nm}: нет описания, а по нему Claude решает, когда звать агента.` });
    if (!c.prompt.trim()) out.push({ level: 'warn', node: n.id, text: `${nm}: пустой системный промпт.` });
    if (c.toolsMode === 'list' && !c.tools.length && !c.extraTools.trim() && !kidsOf(n.id).length)
      out.push({ level: 'warn', node: n.id, text: `${nm}: не выбран ни один инструмент, поэтому агент получит все.` });
    if (c.toolsMode === 'inherit' && kidsOf(n.id).length)
      out.push({ level: 'info', node: n.id, text: `${nm}: инструменты не ограничены, поэтому он сможет вызывать любых агентов, а не только своих.` });
    if (c.permissionMode === 'bypassPermissions')
      out.push({ level: 'warn', node: n.id, text: `${nm}: режим без проверок, агент выполнит любую команду без вопросов.` });
  }
  const cyclic = hasCycle();
  if (cyclic) out.push({ level: 'warn', text: 'В схеме есть цикл: агенты могут бесконечно передавать задачу друг другу.' });
  const entry = byId(S.entry);
  if (!entry) out.push({ level: 'warn', text: 'Не выбран входной агент, которому вы будете давать задачи.' });
  else {
    if (!cyclic) {
      const main = S.target.scope === 'project' && S.entryInSettings;
      const limit = main ? 3 : 2, depth = maxDepth(entry.id);
      if (depth > limit) out.push({
        level: 'warn',
        text: `Цепочка вызовов в ${depth} шага. Claude Code разрешает не больше трёх уровней вложенности${main ? '' : ' (при вызове через @agent вход уже первый уровень)'}, поэтому нижние агенты не смогут никого вызвать.`,
      });
    }
    const reach = reachable(entry.id);
    const lost = S.nodes.filter(n => !reach.has(n.id)).map(n => n.cfg.name);
    if (lost.length) out.push({ level: 'info', text: `Не связаны с входом: ${lost.join(', ')}. Их можно вызвать только напрямую, через @agent-имя.` });
  }
  if (S.target.scope === 'project' && !S.target.path.trim()) out.push({ level: 'err', text: 'Не указана папка проекта.' });
  return out;
}

// ---------- холст ----------

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
const anchorOut = n => [n.x + NODE_W + 12, n.y + (heights[n.id] || 100) / 2];
const anchorIn = n => [n.x - 6, n.y + (heights[n.id] || 100) / 2];
function curve(a, b) {
  const back = b[0] < a[0];
  const dx = back ? Math.abs(b[0] - a[0]) / 2 + 80 : Math.max(40, (b[0] - a[0]) / 2);
  return [a, [a[0] + dx, a[1]], [b[0] - dx, b[1]], b];
}

// Агенты в одной колонке соединяем вертикально, иначе стрелка прячется за карточками.
function edgeCurve(s, t) {
  if (Math.abs(s.x - t.x) >= NODE_W * 0.75) return curve(anchorOut(s), anchorIn(t));
  const cx = x => x + NODE_W / 2, hs = heights[s.id] || 100, ht = heights[t.id] || 100;
  const down = t.y > s.y;
  const a = [cx(s.x), down ? s.y + hs : s.y];
  const b = [cx(t.x), down ? t.y - 6 : t.y + ht + 6];
  const dy = Math.max(30, Math.abs(b[1] - a[1]) / 2) * (down ? 1 : -1);
  return [a, [a[0], a[1] + dy], [b[0], b[1] - dy], b];
}
const pathD = p => `M${p[0][0]},${p[0][1]} C${p[1][0]},${p[1][1]} ${p[2][0]},${p[2][1]} ${p[3][0]},${p[3][1]}`;
const midPoint = p => [0, 1].map(i => 0.125 * p[0][i] + 0.375 * p[1][i] + 0.375 * p[2][i] + 0.125 * p[3][i]);

function caps(c) {
  if (c.toolsMode === 'inherit') return ['все инструменты'];
  const t = new Set(c.tools), out = [];
  if (['Read', 'Grep', 'Glob'].some(x => t.has(x))) out.push('чтение');
  if (EDIT_TOOLS.some(x => t.has(x))) out.push('правка');
  if (t.has('Bash')) out.push('команды');
  if (t.has('WebSearch') || t.has('WebFetch')) out.push('интернет');
  if (c.extraTools.trim()) out.push('+ свои');
  return out.length ? out : ['без инструментов'];
}

const chip = (text, tone) => el('span', { class: 'chip', style: `--k:var(--k-${tone})` }, text);
const EFFORT_LEVEL = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

function effortMeter(effort) {
  if (!effort) return el('span', { class: 'meter', title: 'Глубина размышлений как в сессии' }, 'мысли: как в сессии');
  const lv = EFFORT_LEVEL[effort] || 3;
  const label = (EFFORTS.find(e => e[0] === effort) || ['', effort])[1].toLowerCase();
  return el('span', { class: `meter lv${lv}`, title: `Глубина размышлений: ${label} (${effort})` },
    'мысли', el('span', { class: 'bars' }, [1, 2, 3, 4, 5].map(i => el('i', { class: i <= lv ? 'on' : '' }))));
}

function initMarkers() {
  const defs = $('#edge-defs');
  for (const c of COLORS) {
    const m = svg('marker', { id: `arrow-${c}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(svg('path', { d: 'M0 0 10 5 0 10z', style: `fill:var(--c-${c})` }));
    defs.append(m);
  }
}

function renderCanvas() {
  renderNodes();
  renderEdges();
  $('#empty-hint').classList.toggle('on', !S.nodes.length);
}

function renderNodes() {
  const layer = $('#node-layer');
  layer.textContent = '';
  const bad = new Set(validate().filter(i => i.level === 'err' && i.node).map(i => i.node));
  for (const n of S.nodes) {
    const c = n.cfg, role = ROLES[n.role] || ROLES.custom;
    const selected = sel?.type === 'node' && sel.id === n.id;
    layer.append(el('div', {
      class: `node${selected ? ' selected' : ''}${bad.has(n.id) ? ' has-error' : ''}`,
      'data-id': n.id,
      style: `left:${n.x}px;top:${n.y}px;--c:var(--c-${c.color})`,
    },
      el('div', { class: 'port in' }),
      el('div', { class: 'node-head' },
        el('span', { class: 'node-icon', html: icon(n.role, 16) }),
        el('div', { class: 'node-titles' },
          el('div', { class: 'node-name' }, c.name || 'без имени'),
          el('div', { class: 'node-role' }, role.label)),
        S.entry === n.id ? el('span', { class: 'badge' }, 'вход') : null),
      el('div', { class: 'node-body' },
        el('div', { class: 'node-meta' },
          chip(MODEL_SHORT[c.model] ?? c.model, MODEL_TONE[c.model] || 'gray'),
          effortMeter(c.effort)),
        el('div', { class: 'node-caps' }, caps(c).map(t => chip(t, CAP_TONE[t] || 'gray')))),
      el('button', {
        class: 'port out', type: 'button', html: icon('plus', 13, 3),
        title: 'Нажмите, чтобы добавить подчинённого агента. Потяните к другому агенту, чтобы связать.',
      })));
  }
  for (const d of layer.children) heights[d.dataset.id] = d.offsetHeight;
}

function renderEdges() {
  const g = $('#edge-layer');
  g.textContent = '';
  for (const e of S.edges) {
    const a = byId(e.from), b = byId(e.to);
    if (!a || !b) continue;
    const p = edgeCurve(a, b), d = pathD(p);
    const on = sel?.type === 'edge' && sel.from === e.from && sel.to === e.to;
    const col = `var(--c-${a.cfg.color})`;
    g.append(svg('path', {
      d, class: `edge${on ? ' sel' : ''}`, 'marker-end': `url(#arrow-${a.cfg.color})`,
      style: `stroke:${col};--edge-glow:${col}`,
    }));
    const sibs = S.edges.filter(x => x.from === e.from);
    if (sibs.length > 1) {
      const [mx, my] = midPoint(p);
      const grp = svg('g', { class: 'edge-num' });
      grp.append(svg('circle', { cx: mx, cy: my, r: 9, style: `fill:${col}` }));
      const t = svg('text', { x: mx, y: my });
      t.textContent = sibs.indexOf(e) + 1;
      grp.append(t);
      g.append(grp);
    }
    g.append(svg('path', { d, class: 'edge-hit', 'data-from': e.from, 'data-to': e.to }));
  }
}

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  canvas.style.backgroundSize = `${20 * view.k}px ${20 * view.k}px`;
  canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $('#zoom-reset').textContent = `${Math.round(view.k * 100)}%`;
}

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left - view.x) / view.k, (e.clientY - r.top - view.y) / view.k];
}

function zoomAt(px, py, f) {
  viewTouched = true;
  const k = clamp(view.k * f, 0.3, 2);
  view.x = px - (px - view.x) * k / view.k;
  view.y = py - (py - view.y) * k / view.k;
  view.k = k;
  applyView();
}

function zoomCenter(f) { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, f); }

function fitView() {
  viewTouched = false;
  const r = canvas.getBoundingClientRect();
  if (r.width < 50 || r.height < 50) return;
  if (!S.nodes.length) { view = { x: r.width / 2 - NODE_W / 2, y: r.height / 3, k: 1 }; applyView(); return; }
  const minX = Math.min(...S.nodes.map(n => n.x)) - 30;
  const maxX = Math.max(...S.nodes.map(n => n.x)) + NODE_W + 30;
  const minY = Math.min(...S.nodes.map(n => n.y)) - 30;
  const maxY = Math.max(...S.nodes.map(n => n.y + (heights[n.id] || 100))) + 30;
  const k = clamp(Math.min((r.width - 60) / (maxX - minX), (r.height - 90) / (maxY - minY)), 0.35, 1);
  view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - 40 - (maxY - minY) * k) / 2 - minY * k };
  applyView();
}

function layout() {
  if (!S.nodes.length) return;
  const depth = {};
  const entry = byId(S.entry);
  const start = [...(entry ? [entry] : []), ...roots().filter(n => n.id !== S.entry)];
  const q = (start.length ? start : [S.nodes[0]]).map(n => n.id);
  q.forEach(id => { depth[id] = 0; });
  for (let i = 0; i < q.length; i++) {
    for (const k of kidsOf(q[i])) if (!(k.id in depth)) { depth[k.id] = depth[q[i]] + 1; q.push(k.id); }
  }
  for (const n of S.nodes) if (!(n.id in depth)) { depth[n.id] = 0; q.push(n.id); }
  const layers = {};
  for (const id of q) (layers[depth[id]] ||= []).push(id);
  for (const [d, ids] of Object.entries(layers)) {
    ids.forEach((id, i) => {
      const n = byId(id);
      n.x = d * 300;
      n.y = Math.round((i - (ids.length - 1) / 2) * ROW_GAP);
    });
  }
}

// ---------- действия с графом ----------

function changed(rebuild = false) {
  dirty = true;
  saveDraft();
  renderCanvas();
  renderStatus();
  if (rebuild) renderInspector(); else refreshLive();
}

function setSel(s) {
  sel = s;
  renderCanvas();
  renderInspector();
}

// opts: {x, y} — левый верхний угол карточки; parentId — сразу подключить к этому агенту.
function addNode(role, opts = {}) {
  const preset = ROLES[role] || ROLES.custom;
  const cfg = normCfg(clone(preset.cfg));
  cfg.name = uniqueName(cfg.name);
  cfg.color = pickColor(cfg.color);
  const parent = opts.parentId ? byId(opts.parentId) : null;
  let { x, y } = opts;
  if (x == null && parent) {
    const kids = kidsOf(parent.id);
    x = parent.x + 300;
    y = kids.length ? Math.max(...kids.map(k => k.y)) + ROW_GAP : parent.y;
  } else if (x == null) {
    const r = canvas.getBoundingClientRect();
    x = (r.width / 2 - view.x) / view.k - NODE_W / 2;
    y = (r.height / 2 - view.y) / view.k - 50;
  }
  for (let i = 0; i < 20 && S.nodes.some(n => Math.abs(n.x - x) < 40 && Math.abs(n.y - y) < 40); i++) { x += 30; y += 30; }
  const n = { id: uid(), role, x: Math.round(x), y: Math.round(y), cfg };
  S.nodes.push(n);
  if (parent) S.edges.push({ from: parent.id, to: n.id });
  if (!byId(S.entry)) S.entry = n.id;
  sel = { type: 'node', id: n.id };
  tab = 'settings';
  changed(true);
  ensureVisible(n);
  toast(parent ? `Добавлен ${cfg.name}, его вызывает ${parent.cfg.name}` : `Добавлен ${cfg.name}`);
}

// Если новая карточка оказалась за краем холста — сдвигаем вид к ней.
function ensureVisible(n) {
  const r = canvas.getBoundingClientRect();
  const sx = n.x * view.k + view.x, sy = n.y * view.k + view.y;
  const w = NODE_W * view.k, h = (heights[n.id] || 110) * view.k;
  const pad = 40;
  let dx = 0, dy = 0;
  if (sx < pad) dx = pad - sx; else if (sx + w > r.width - pad) dx = r.width - pad - (sx + w);
  if (sy < pad) dy = pad - sy; else if (sy + h > r.height - 90) dy = r.height - 90 - (sy + h);
  if (dx || dy) { view.x += dx; view.y += dy; applyView(); }
}

// ---------- меню «какого агента добавить» ----------

let roleMenu = null;

function openRoleMenu(pos, title, onPick, connectTo = null) {
  closeRoleMenu();
  let connect = !!connectTo;
  const menu = el('div', { class: 'role-menu', role: 'menu' },
    el('div', { class: 'role-menu-title' }, title),
    Object.entries(ROLES).map(([key, r]) => el('button', {
      class: 'role-item', role: 'menuitem', style: `--c:var(--c-${r.cfg.color})`,
      onclick: () => { closeRoleMenu(); onPick(key, connect); },
    }, el('span', { class: 'role-icon', html: icon(key, 16) }), el('span', {}, el('b', {}, r.label), el('small', {}, r.hint)))),
    connectTo ? el('div', { class: 'role-menu-opt' },
      check(true, `Сразу подключить к ${connectTo.cfg.name}`, `${connectTo.cfg.name} сможет поручать ему задачи`, v => { connect = v; })) : null,
    el('div', { class: 'role-menu-foot' }, 'Связать с уже существующим агентом: потяните за «+» у карточки.'));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  let x = pos.x, y = pos.y;
  if (pos.above) { x = pos.x - r.width; y = pos.y - r.height - 10; }
  menu.style.left = `${clamp(x, 8, innerWidth - r.width - 8)}px`;
  menu.style.top = `${clamp(y, 8, innerHeight - r.height - 8)}px`;
  roleMenu = menu;
  menu.querySelector('.role-item')?.focus();
  setTimeout(() => document.addEventListener('pointerdown', closeRoleMenuOutside, true));
}

function closeRoleMenuOutside(e) { if (roleMenu && !roleMenu.contains(e.target)) closeRoleMenu(); }
function closeRoleMenu() {
  roleMenu?.remove();
  roleMenu = null;
  document.removeEventListener('pointerdown', closeRoleMenuOutside, true);
}

function addFromFab() {
  const r = $('#fab-add').getBoundingClientRect();
  const parent = sel?.type === 'node' ? byId(sel.id) : null;
  openRoleMenu({ x: r.right, y: r.top, above: true }, 'Какого агента добавить?',
    (role, connect) => addNode(role, { parentId: connect && parent ? parent.id : null }), parent);
}

function deleteNode(id) {
  const n = byId(id);
  if (!n) return;
  S.nodes = S.nodes.filter(x => x.id !== id);
  S.edges = S.edges.filter(e => e.from !== id && e.to !== id);
  if (S.entry === id) S.entry = (roots()[0] || S.nodes[0])?.id || null;
  sel = null;
  changed(true);
  toast(`Агент ${n.cfg.name} удалён с холста`);
}

function duplicateNode(id) {
  const n = byId(id);
  const cfg = clone(n.cfg);
  cfg.name = uniqueName(n.cfg.name);
  cfg.color = pickColor(cfg.color);
  const copyNode = { id: uid(), role: n.role, x: n.x + 30, y: n.y + (heights[n.id] || 100) + 40, cfg };
  S.nodes.push(copyNode);
  for (const e of S.edges.filter(e => e.to === id)) S.edges.push({ from: e.from, to: copyNode.id });
  sel = { type: 'node', id: copyNode.id };
  changed(true);
}

function addEdge(from, to) {
  if (from === to) return;
  if (findEdge(from, to)) { toast('Такая связь уже есть'); return; }
  S.edges.push({ from, to });
  const a = byId(from).cfg.name, b = byId(to).cfg.name;
  changed(true);
  toast(`Теперь ${a} может вызывать ${b}`);
}

function removeEdge(e) {
  S.edges = S.edges.filter(x => x !== e);
  if (sel?.type === 'edge' && sel.from === e.from && sel.to === e.to) sel = null;
  changed(true);
}

function moveEdge(e, dir) {
  const sibs = S.edges.filter(x => x.from === e.from);
  const i = sibs.indexOf(e), j = i + dir;
  if (j < 0 || j >= sibs.length) return;
  const a = S.edges.indexOf(sibs[i]), b = S.edges.indexOf(sibs[j]);
  [S.edges[a], S.edges[b]] = [S.edges[b], S.edges[a]];
  changed(true);
}

function reverseEdge(e) {
  if (findEdge(e.to, e.from)) { removeEdge(e); return; }
  [e.from, e.to] = [e.to, e.from];
  sel = { type: 'edge', from: e.from, to: e.to };
  changed(true);
}

function deleteSelection() {
  if (sel?.type === 'node') deleteNode(sel.id);
  else if (sel?.type === 'edge') { const e = findEdge(sel.from, sel.to); if (e) removeEdge(e); }
}

// ---------- мышь и клавиатура ----------

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('.canvas-tools, .empty-hint .btn, .fab')) return;
  const port = e.target.closest('.port.out');
  const nodeEl = e.target.closest('.node');
  const hit = e.target.closest('.edge-hit');
  canvas.focus({ preventScroll: true });
  if (port && nodeEl) {
    drag = { mode: 'link', from: nodeEl.dataset.id, sx: e.clientX, sy: e.clientY, moved: false };
    port.classList.add('active');
  } else if (nodeEl) {
    const n = byId(nodeEl.dataset.id);
    const [wx, wy] = toWorld(e);
    drag = { mode: 'node', id: n.id, dx: wx - n.x, dy: wy - n.y, moved: false };
    if (!(sel?.type === 'node' && sel.id === n.id)) setSel({ type: 'node', id: n.id });
  } else if (hit) {
    setSel({ type: 'edge', from: hit.dataset.from, to: hit.dataset.to });
    return;
  } else {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    canvas.classList.add('panning');
  }
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.mode === 'node') {
    const [wx, wy] = toWorld(e);
    const n = byId(drag.id);
    const nx = Math.round((wx - drag.dx) / 10) * 10, ny = Math.round((wy - drag.dy) / 10) * 10;
    if (nx === n.x && ny === n.y) return;
    n.x = nx; n.y = ny; drag.moved = true;
    const d = $(`.node[data-id="${n.id}"]`);
    if (d) { d.style.left = `${n.x}px`; d.style.top = `${n.y}px`; d.classList.add('dragging'); }
    renderEdges();
  } else if (drag.mode === 'pan') {
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) { drag.moved = true; viewTouched = true; }
    view.x = drag.vx + e.clientX - drag.sx;
    view.y = drag.vy + e.clientY - drag.sy;
    applyView();
  } else if (drag.mode === 'link') {
    if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 5) return;
    drag.moved = true;
    const from = byId(drag.from);
    const temp = $('#temp-edge');
    temp.style.display = 'block';
    temp.style.stroke = `var(--c-${from.cfg.color})`;
    temp.setAttribute('marker-end', `url(#arrow-${from.cfg.color})`);
    temp.setAttribute('d', pathD(curve(anchorOut(from), toWorld(e))));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    for (const d of document.querySelectorAll('.node.drop-target')) if (d !== over) d.classList.remove('drop-target');
    if (over && over.dataset.id !== drag.from) over.classList.add('drop-target');
  }
});

canvas.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode === 'node' && d.moved) changed();
  if (d.mode === 'pan') {
    canvas.classList.remove('panning');
    if (!d.moved && sel) setSel(null);
  }
  if (d.mode === 'link') {
    $('#temp-edge').style.display = 'none';
    document.querySelectorAll('.drop-target, .port.active').forEach(x => x.classList.remove('drop-target', 'active'));
    const from = byId(d.from);
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    if (!d.moved) {
      // Просто нажали «+» — добавляем подчинённого.
      openRoleMenu({ x: e.clientX + 16, y: e.clientY - 24 }, `Кого будет вызывать ${from.cfg.name}?`,
        role => addNode(role, { parentId: from.id }));
    } else if (over && over.dataset.id !== d.from) {
      addEdge(d.from, over.dataset.id);
    } else if (!over) {
      // Отпустили стрелку на пустом месте — создаём нового агента там же.
      const [wx, wy] = toWorld(e);
      openRoleMenu({ x: e.clientX + 8, y: e.clientY - 24 }, `Новый агент для ${from.cfg.name}`,
        role => addNode(role, { parentId: from.id, x: wx, y: wy - 45 }));
    }
  }
});

canvas.addEventListener('dblclick', e => {
  if (e.target.closest('.node, .canvas-tools, .fab, .edge-hit, .empty-hint .actions')) return;
  const [wx, wy] = toWorld(e);
  openRoleMenu({ x: e.clientX + 8, y: e.clientY - 24 }, 'Новый агент',
    role => addNode(role, { x: wx - NODE_W / 2, y: wy - 45 }));
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
  } else {
    viewTouched = true;
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyView();
  }
}, { passive: false });

new ResizeObserver(() => { if (!viewTouched) fitView(); }).observe(canvas);

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveSystem(); return; }
  if (e.key === 'Escape' && roleMenu) { closeRoleMenu(); return; }
  if (e.key === 'Escape' && $('#modal-root').children.length) { closeModal(); return; }
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSelection(); }
  else if (e.key === 'Escape' && sel) setSel(null);
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && sel?.type === 'node') { e.preventDefault(); duplicateNode(sel.id); }
});

// ---------- панель справа ----------

function field(label, control, help) {
  const input = [control].flat().find(c => c?.matches?.('input, select, textarea'));
  if (label && input && !input.id) input.id = `f-${uid()}`;
  return el('div', { class: 'field' },
    label ? el('label', { for: input?.id }, label) : null,
    control,
    help ? el('div', { class: 'help' }, help) : null);
}

function select_(options, value, onchange) {
  return el('select', { class: 'select', onchange: e => onchange(e.target.value) },
    options.map(([v, t]) => el('option', { value: v, selected: v === value }, t)));
}

function seg(options, value, onpick) {
  return el('div', { class: 'seg' }, options.map(([v, t]) =>
    el('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => onpick(v) }, t)));
}

function check(value, label, small, onchange) {
  return el('label', { class: 'check' },
    el('input', { type: 'checkbox', checked: !!value, onchange: e => onchange(e.target.checked) }),
    el('span', {}, label, small ? el('small', {}, small) : null));
}

function setTitle(text) { const t = $('#insp-title'); if (t) t.textContent = text || 'без имени'; }

function renderInspector() {
  const root = $('#inspector');
  const scroll = root.scrollTop;
  const sameTarget = root.dataset.sel === JSON.stringify(sel);
  root.textContent = '';
  if (sel?.type === 'node' && byId(sel.id)) root.append(...nodePanel(byId(sel.id)));
  else if (sel?.type === 'edge' && findEdge(sel.from, sel.to)) root.append(...edgePanel(findEdge(sel.from, sel.to)));
  else { sel = null; root.append(...systemPanel()); }
  root.dataset.sel = JSON.stringify(sel);
  root.scrollTop = sameTarget ? scroll : 0;
  refreshLive();
}

function refreshLive() {
  const issues = $('#live-issues');
  if (issues) renderIssues(issues);
  const howto = $('#live-howto');
  if (howto) { howto.textContent = ''; howto.append(howtoBlock()); }
  const n = sel?.type === 'node' ? byId(sel.id) : null;
  const preview = $('#live-preview');
  if (preview && n) preview.textContent = buildMd(n);
  const auto = $('#live-auto');
  if (auto && n) {
    auto.textContent = '';
    const kids = kidsOf(n.id);
    if (kids.length && n.cfg.toolsMode === 'list') {
      auto.append(el('div', { class: 'auto-line' }, 'По стрелкам добавится само: ',
        el('code', {}, `Agent(${kids.map(k => k.cfg.name).join(', ')})`)));
    } else if (kids.length) {
      auto.append(el('div', { class: 'auto-line' }, 'Инструменты не ограничены, поэтому он сможет вызывать любых агентов.'));
    }
  }
}

function renderIssues(box) {
  box.textContent = '';
  const list = validate();
  if (!list.length) {
    box.append(el('div', { class: 'issue ok' }, el('span', { class: 'ic' }, '✓'), el('span', {}, 'Ошибок нет, можно устанавливать.')));
    return;
  }
  for (const i of list) {
    box.append(el('div', {
      class: `issue ${i.level}`,
      'data-node': i.node || null,
      onclick: i.node ? () => setSel({ type: 'node', id: i.node }) : null,
    }, el('span', { class: 'ic' }, i.level === 'info' ? 'i' : '!'), el('span', {}, i.text)));
  }
}

function howtoBlock() {
  const entry = byId(S.entry);
  const box = el('div', { class: 'howto' });
  if (!entry) { box.append(el('p', {}, 'Выберите входного агента: ему вы будете давать задачи.')); return box; }
  const nm = entry.cfg.name;
  box.append(el('p', {}, 'В любой сессии Claude Code: ', el('code', {}, `@agent-${nm} ваша задача`)));
  box.append(el('p', {}, 'Главным агентом в терминале: ', el('code', {}, `claude --agent ${nm}`)));
  if (S.target.scope === 'project') {
    box.append(el('p', {}, S.entryInSettings
      ? 'В новых сессиях этого проекта он запустится сам.'
      : 'Агенты будут видны только в сессиях этого проекта.'));
  }
  if (S.target.scope === 'user' && !env.userAgentsDirExists) {
    box.append(el('p', {}, 'Папки ~/.claude/agents пока нет. После первой установки перезапустите Claude Code.'));
  }
  return box;
}

function H(text, tone) {
  return el('h2', tone ? { class: 'tone', style: `--t:var(--k-${tone})` } : {}, text);
}

function systemPanel() {
  const t = S.target;
  const head = el('div', { class: 'insp-head' },
    el('span', { class: 'head-icon system', html: icon('system', 18, 2.2) }),
    el('div', { class: 'grow' },
      el('div', { class: 'title', id: 'insp-title' }, S.name || 'Без названия'),
      el('div', { class: 'sub' }, `Система · ${plural(S.nodes.length, 'агент', 'агента', 'агентов')}, ${plural(S.edges.length, 'связь', 'связи', 'связей')}`)));

  const where = el('div', {},
    el('div', { class: 'target-card' },
      el('span', { class: 'proj-icon', style: `--t:var(--k-${t.scope === 'user' ? 'violet' : 'blue'})`, html: icon(t.scope === 'user' ? 'globe' : 'folder', 17) }),
      el('div', { class: 'grow', title: targetDir() },
        el('b', {}, targetName()), el('span', { class: 'path' }, shortPath(targetDir(), 44))),
      el('button', { class: 'btn small', onclick: openTargetPicker }, 'Сменить…')),
    el('div', { class: 'help' }, t.scope === 'user'
      ? 'Агенты будут доступны в любом проекте.'
      : 'Агенты будут видны только в сессиях этого проекта.'));

  const entryPick = select_([['', '— не выбран —'], ...S.nodes.map(n => [n.id, n.cfg.name])], S.entry || '',
    v => { S.entry = v || null; changed(true); });
  const entryMain = t.scope === 'project'
    ? check(S.entryInSettings, 'Запускать его в каждой новой сессии проекта',
      'Запишу "agent" в .claude/settings.json проекта. Он станет главным агентом сессии, и список тех, кого ему можно вызывать, будет соблюдаться строго.',
      v => { S.entryInSettings = v; changed(true); })
    : null;

  return [head, el('div', { class: 'insp-body' },
    el('div', { class: 'section' }, H('Куда установить', 'blue'), where),
    el('div', { class: 'section' }, H('Входной агент', 'orange'),
      field(null, entryPick, 'Ему вы даёте задачу, остальных он вызывает сам по стрелкам.'),
      entryMain),
    el('div', { class: 'section' }, H('Проверка', 'green'), el('div', { id: 'live-issues', class: 'issues' })),
    el('div', { class: 'section' }, H('Как запустить', 'violet'), el('div', { id: 'live-howto' })))];
}

function nodePanel(n) {
  const c = n.cfg, role = ROLES[n.role] || ROLES.custom, isEntry = S.entry === n.id;
  const head = el('div', { class: 'insp-head agent', style: `--c:var(--c-${c.color})` },
    el('span', { class: 'head-icon', html: icon(n.role, 18) }),
    el('div', { class: 'grow' },
      el('div', { class: 'title', id: 'insp-title' }, c.name || 'без имени'),
      el('div', { class: 'sub' }, role.label + (isEntry ? ' · входной агент' : ''))),
    isEntry ? null : el('button', { class: 'btn small', onclick: () => { S.entry = n.id; changed(true); } }, 'Сделать входом'));
  const tabs = el('div', { class: 'tabs' }, [['settings', 'Настройки'], ['file', 'Файл']].map(([k, label]) =>
    el('button', { class: `tab${tab === k ? ' on' : ''}`, onclick: () => { tab = k; renderInspector(); } }, label)));
  const body = el('div', { class: 'insp-body' });
  if (tab === 'file') {
    body.append(el('div', { class: 'section' },
      el('div', { class: 'help', style: 'margin:0 0 8px' }, 'Так файл будет выглядеть после установки: ', el('code', {}, `${targetDir()}/${c.name}.md`)),
      el('pre', { class: 'preview', id: 'live-preview' }),
      el('div', { class: 'actions', style: 'margin-top:8px' },
        el('button', { class: 'btn small', onclick: () => copy(buildMd(n)) }, 'Копировать'))));
  } else {
    body.append(...nodeSettings(n));
  }
  return [head, tabs, body];
}

function nodeSettings(n) {
  const c = n.cfg;
  const rename = (v, input) => { c.name = v; if (input.value !== v) input.value = v; setTitle(v); changed(); };
  const nameInput = el('input', {
    class: 'input mono', value: c.name, spellcheck: 'false',
    oninput: e => rename(slugName(e.target.value), e.target),
    onblur: e => {
      const v = slugName(e.target.value, true) || uniqueName(n.role === 'custom' ? 'agent' : n.role, n.id);
      if (v !== c.name || v !== e.target.value) rename(v, e.target);
    },
  });

  const basics = el('div', { class: 'section' }, H('Основное', 'orange'),
    field('Имя', nameInput, 'Латиница, цифры и дефис. Русские буквы переведутся сами.'),
    field('Когда его вызывать', el('textarea', {
      class: 'textarea', rows: 3, value: c.description,
      oninput: e => { c.description = e.target.value; changed(); },
    }), 'По этому описанию Claude решает, какому агенту отдать задачу.'),
    field('Системный промпт', el('textarea', {
      class: 'textarea prompt', value: c.prompt,
      oninput: e => { c.prompt = e.target.value; changed(); },
    })),
    check(c.teamSection, 'Дописывать в промпт состав команды',
      'Кого агент вызывает и кому отчитывается, по стрелкам. Результат виден на вкладке «Файл».',
      v => { c.teamSection = v; changed(); }));

  const model = el('div', { class: 'section' }, H('Модель', 'violet'),
    el('div', { class: 'row' },
      field('Модель', select_(MODELS, c.model, v => { c.model = v; changed(); })),
      field('Глубина размышлений', select_(EFFORTS, c.effort, v => { c.effort = v; changed(); }))),
    el('div', { class: 'help' }, 'Чем глубже размышления, тем точнее ответ, но медленнее и дороже.'));

  const toolChecks = TOOL_GROUPS.map(([group, tools]) => {
    const tone = `--t:var(--k-${GROUP_TONE[group] || 'gray'})`;
    return [
      el('div', { class: 'tool-group', style: tone }, group),
      tools.map(([t, desc]) => el('label', { class: 'check', title: desc, style: tone },
        el('input', { type: 'checkbox', checked: c.tools.includes(t), onchange: e => { toggleIn(c.tools, t, e.target.checked); changed(); } }),
        el('span', {}, el('code', {}, t), el('small', {}, desc)))),
    ];
  });
  const toolsSection = el('div', { class: 'section' }, H('Инструменты и разрешения', 'teal'),
    seg([['list', 'Только выбранные'], ['inherit', 'Все, как в сессии']], c.toolsMode, v => { c.toolsMode = v; changed(true); }),
    c.toolsMode === 'list'
      ? [el('div', { class: 'tool-grid' }, toolChecks),
        el('div', { style: 'margin-top:10px' }, field('Другие инструменты', el('input', {
          class: 'input mono', value: c.extraTools, placeholder: 'mcp__github, Bash(git:*)', spellcheck: 'false',
          oninput: e => { c.extraTools = e.target.value; changed(); },
        }), 'Через запятую: инструменты MCP-серверов и точные правила.'))]
      : el('div', { class: 'help' }, 'Агент получит все инструменты сессии, включая MCP-серверы.'),
    el('div', { id: 'live-auto' }),
    el('div', { style: 'margin-top:12px' }, field('Разрешения',
      select_(PERMISSIONS, c.permissionMode, v => { c.permissionMode = v; changed(); }),
      'Спрашивать ли вас перед правками файлов и командами.')));

  const out = S.edges.filter(e => e.from === n.id);
  const inc = S.edges.filter(e => e.to === n.id);
  const item = (other, extra) => el('div', { class: 'list-item', style: `--c:var(--c-${other.cfg.color})` },
    extra.num != null ? el('span', { class: 'num' }, extra.num) : null,
    el('span', { class: 'dot' }),
    el('span', { class: 'name', title: 'Открыть', onclick: () => setSel({ type: 'node', id: other.id }) }, other.cfg.name),
    extra.buttons);
  const outList = out.length
    ? el('div', { class: 'list' }, out.map((e, i) => item(byId(e.to), {
      num: out.length > 1 ? i + 1 : null,
      buttons: [
        out.length > 1 ? el('button', { class: 'mini', title: 'Раньше', disabled: i === 0, onclick: () => moveEdge(e, -1) }, '↑') : null,
        out.length > 1 ? el('button', { class: 'mini', title: 'Позже', disabled: i === out.length - 1, onclick: () => moveEdge(e, 1) }, '↓') : null,
        el('button', { class: 'mini', title: 'Удалить связь', onclick: () => removeEdge(e) }, '×'),
      ],
    })))
    : el('div', { class: 'list-empty' }, 'Никого. Потяните стрелку от кружка справа у агента.');
  const candidates = S.nodes.filter(o => o.id !== n.id && !out.some(e => e.to === o.id));
  const inList = inc.length
    ? el('div', { class: 'list' }, inc.map(e => item(byId(e.from), {
      buttons: el('button', { class: 'mini', title: 'Удалить связь', onclick: () => removeEdge(e) }, '×'),
    })))
    : el('div', { class: 'list-empty' }, S.entry === n.id
      ? 'Никто: это входной агент, задачу ему даёте вы.'
      : `Никто. Вызвать его можно только напрямую: @agent-${c.name}`);
  const links = el('div', { class: 'section' }, H('Связи', 'blue'),
    el('label', { class: 'label' }, 'Вызывает'), outList,
    candidates.length ? el('div', { style: 'margin-top:6px' },
      select_([['', '+ Добавить, кого он вызывает…'], ...candidates.map(o => [o.id, o.cfg.name])], '', v => v && addEdge(n.id, v))) : null,
    el('label', { class: 'label', style: 'margin-top:14px' }, 'Кто его вызывает'), inList);

  const knownSkills = env.skills || [];
  const otherSkills = c.skills.filter(s => !knownSkills.includes(s));
  const adv = el('details', { class: 'section', open: !!(c.maxTurns || c.memory || c.skills.length || c.extraYaml) },
    el('summary', {}, 'Дополнительно'),
    el('div', { class: 'row' },
      field('Максимум шагов', el('input', {
        class: 'input', type: 'number', min: '1', value: c.maxTurns, placeholder: 'без ограничения',
        oninput: e => { c.maxTurns = e.target.value ? String(Math.max(1, parseInt(e.target.value, 10) || 1)) : ''; changed(); },
      })),
      field('Память между сессиями', select_(MEMORY, c.memory, v => { c.memory = v; changed(); }))),
    field('Навыки (skills)', [
      knownSkills.length ? el('div', { class: 'tool-grid' }, knownSkills.map(s => el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: c.skills.includes(s), onchange: e => { toggleIn(c.skills, s, e.target.checked); changed(); } }),
        el('span', {}, s)))) : null,
      el('input', {
        class: 'input mono', style: knownSkills.length ? 'margin-top:6px' : null,
        value: otherSkills.join(', '), placeholder: 'другие навыки через запятую', spellcheck: 'false',
        oninput: e => {
          const extra = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
          c.skills = [...c.skills.filter(s => knownSkills.includes(s)), ...extra];
          changed();
        },
      }),
    ], 'Навык целиком загрузится в агента при старте.'),
    field('Цвет', el('div', { class: 'swatches' }, COLORS.map(col => el('button', {
      class: `swatch${c.color === col ? ' on' : ''}`, style: `--c:var(--c-${col})`, title: col,
      onclick: () => { c.color = col; changed(true); },
    })))),
    field('Свой YAML', el('textarea', {
      class: 'textarea mono', rows: 4, value: c.extraYaml, spellcheck: 'false',
      placeholder: 'hooks:\n  …\nmcpServers:\n  - github',
      oninput: e => { c.extraYaml = e.target.value; changed(); },
    }), 'Попадёт во frontmatter как есть: hooks, mcpServers, disallowedTools и другие поля.'));

  const actions = el('div', { class: 'section actions' },
    el('button', { class: 'btn small', onclick: () => duplicateNode(n.id) }, 'Дублировать'),
    el('button', { class: 'btn small danger', onclick: () => deleteNode(n.id) }, 'Удалить агента'));

  return [basics, model, toolsSection, links, adv, actions];
}

function edgePanel(e) {
  const a = byId(e.from), b = byId(e.to);
  const sibs = S.edges.filter(x => x.from === e.from), i = sibs.indexOf(e);
  const head = el('div', { class: 'insp-head' },
    el('div', { class: 'grow' },
      el('div', { class: 'title' }, `${a.cfg.name} → ${b.cfg.name}`),
      el('div', { class: 'sub' }, 'Связь')));
  return [head, el('div', { class: 'insp-body' },
    el('div', { class: 'section' },
      el('p', { style: 'margin:0 0 8px' }, `${a.cfg.name} может поручать задачи ${b.cfg.name}.`),
      el('p', { class: 'hint', style: 'margin:0' }, 'Конструктор сам даст ему инструмент ',
        el('code', {}, `Agent(${b.cfg.name})`), ' и допишет в его промпт, чем занимается ', b.cfg.name, '.')),
    sibs.length > 1 ? el('div', { class: 'section' }, H('Порядок', 'blue'),
      el('div', { class: 'row', style: 'align-items:center' },
        el('span', {}, `${i + 1}-й из ${sibs.length} в команде ${a.cfg.name}`),
        el('div', { class: 'actions', style: 'justify-content:flex-end' },
          el('button', { class: 'btn small', disabled: i === 0, onclick: () => moveEdge(e, -1) }, 'Раньше'),
          el('button', { class: 'btn small', disabled: i === sibs.length - 1, onclick: () => moveEdge(e, 1) }, 'Позже')))) : null,
    el('div', { class: 'section actions' },
      el('button', { class: 'btn small', onclick: () => setSel({ type: 'node', id: a.id }) }, `Открыть ${a.cfg.name}`),
      el('button', { class: 'btn small', onclick: () => setSel({ type: 'node', id: b.id }) }, `Открыть ${b.cfg.name}`),
      el('button', { class: 'btn small', onclick: () => reverseEdge(e) }, 'Развернуть'),
      el('button', { class: 'btn small danger', onclick: () => removeEdge(e) }, 'Удалить связь')))];
}

function renderStatus() {
  const list = validate();
  const errs = list.filter(i => i.level === 'err').length, warns = list.filter(i => i.level === 'warn').length;
  const b = $('#status');
  if (!S.nodes.length) { b.className = 'status'; b.textContent = 'Пусто'; }
  else if (errs) { b.className = 'status err'; b.textContent = plural(errs, 'ошибка', 'ошибки', 'ошибок'); }
  else if (warns) { b.className = 'status warn'; b.textContent = plural(warns, 'замечание', 'замечания', 'замечаний'); }
  else { b.className = 'status ok'; b.textContent = '✓ Готово к установке'; }
  $('#dirty').classList.toggle('on', dirty);
  $('#btn-save').classList.toggle('attn', dirty && S.nodes.length > 0);
  document.title = `${dirty ? '• ' : ''}${S.name || 'Без названия'} — Agent Builder`;
  renderTargetChip();
}

// ---------- куда установить ----------

function shortPath(p, max = 0) {
  let s = env.home && p.startsWith(`${env.home}/`) ? `~${p.slice(env.home.length)}` : p;
  if (max && s.length > max) {
    // Сохраняем начало и хвост пути — по ним проект и узнают.
    const tail = s.slice(-(max - 14));
    s = `${s.slice(0, 12)}…${tail.slice(tail.indexOf('/'))}`;
  }
  return s;
}

function targetName(target = S.target) {
  if (target.scope !== 'project') return 'Все проекты';
  const p = (target.path || '').replace(/\/+$/, '');
  return p ? p.split('/').pop() : 'Проект не выбран';
}

function renderTargetChip() {
  const b = $('#target-chip');
  b.textContent = '';
  b.title = `Агенты установятся в ${shortPath(targetDir())}. Нажмите, чтобы выбрать другое место.`;
  b.append(el('span', { html: icon(S.target.scope === 'project' ? 'folder' : 'globe', 15) }),
    el('span', { class: 'tc-label' }, 'Куда:'),
    el('span', { class: 'tc-name' }, targetName()));
}

let projectsCache = null;

async function openTargetPicker() {
  const search = el('input', { class: 'input', placeholder: 'Поиск по названию или пути', spellcheck: 'false', oninput: () => draw() });
  const listBox = el('div', { class: 'picker-list' }, el('div', { class: 'list-empty' }, 'Ищу проекты…'));
  const manual = el('input', {
    class: 'input mono', spellcheck: 'false', placeholder: 'или вставьте путь к папке: /Users/…/project',
    value: S.target.scope === 'project' ? S.target.path : '',
    onkeydown: e => { if (e.key === 'Enter') chooseProject(manual.value.trim()); },
  });
  const body = el('div', {},
    el('div', { class: 'picker-search' }, el('span', { html: icon('search', 15) }), search),
    listBox,
    el('div', { class: 'picker-foot' }, manual,
      el('button', { class: 'btn', onclick: () => chooseProject(manual.value.trim()) }, 'Выбрать')));
  openModal('Куда установить агентов', body, [
    el('button', { class: 'btn left', onclick: pickFolder, html: `${icon('folder', 15)} Выбрать папку в Finder…` }),
    el('button', { class: 'btn', onclick: closeModal }, 'Отмена'),
  ], 'wide');
  search.focus();

  if (!projectsCache) {
    try { projectsCache = (await api('/api/projects')).projects; }
    catch (e) { listBox.textContent = ''; listBox.append(el('div', { class: 'list-empty' }, e.message)); return; }
  }
  draw();

  function row(opts) {
    return el('div', { class: `proj-row${opts.current ? ' current' : ''}`, onclick: opts.onpick },
      el('span', { class: 'proj-icon', style: `--t:var(--k-${opts.tone})`, html: icon(opts.icon, 17) }),
      el('div', { class: 'grow' }, el('b', {}, opts.name), el('span', { class: 'path' }, opts.path)),
      el('div', { class: 'tags' }, opts.tags));
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const match = p => !q || p.name.toLowerCase().includes(q) || p.display.toLowerCase().includes(q);
    const cur = S.target.scope === 'project' ? S.target.path.replace(/\/+$/, '') : null;
    listBox.textContent = '';
    if (!q || 'все проекты'.includes(q)) {
      listBox.append(row({
        name: 'Все проекты', path: '~/.claude/agents', icon: 'globe', tone: 'violet', current: S.target.scope !== 'project',
        tags: [chip('в любом проекте', 'violet'), env.userAgentsCount ? chip(plural(env.userAgentsCount, 'агент', 'агента', 'агентов'), 'orange') : null],
        onpick: () => chooseTarget({ scope: 'user', path: '' }),
      }));
    }
    const groups = [
      ['Вы работали в них с Claude Code', projectsCache.filter(p => p.marks.includes('claude-code') && match(p))],
      ['Другие проекты в домашней папке', projectsCache.filter(p => !p.marks.includes('claude-code') && match(p))],
    ];
    for (const [title, items] of groups) {
      if (!items.length) continue;
      listBox.append(el('div', { class: 'picker-group' }, title));
      for (const p of items) {
        listBox.append(row({
          name: p.name, path: p.display, icon: 'folder', tone: p.marks.includes('claude-code') ? 'blue' : 'gray', current: cur === p.path,
          tags: [
            p.agents ? chip(plural(p.agents, 'агент', 'агента', 'агентов'), 'orange') : null,
            p.usedLabel ? chip(p.usedLabel, 'blue') : null,
            p.marks.includes('git') ? chip('git', 'green') : null,
            p.marks.includes('claude-md') ? chip('CLAUDE.md', 'violet') : null,
          ],
          onpick: () => chooseProject(p.path),
        }));
      }
    }
    if (!listBox.children.length) listBox.append(el('div', { class: 'list-empty' }, 'Ничего не нашлось. Выберите папку в Finder или вставьте путь.'));
  }
}

function chooseProject(path) {
  if (!path) { toast('Укажите папку проекта', 'err'); return; }
  chooseTarget({ scope: 'project', path: path.replace(/\/+$/, '') || '/' });
}

async function pickFolder() {
  toast('Открываю окно выбора папки…');
  try {
    const r = await api('/api/pick-folder', {});
    if (r.path) chooseProject(r.path);
  } catch (e) { toast(e.message, 'err'); }
}

// Выбрали место установки. Если там уже есть агенты — предлагаем загрузить их, чтобы дополнить.
async function chooseTarget(target) {
  let meta;
  try { meta = await api('/api/agents', { target }); }
  catch (e) { toast(e.message, 'err'); return; }
  closeModal();
  S.target = target;
  if (target.scope !== 'project') S.entryInSettings = false;
  changed(true);
  const onCanvas = new Set(S.nodes.map(n => n.cfg.name));
  const fresh = meta.agents.filter(a => !onCanvas.has(a.fields.name));
  if (!fresh.length) { toast(`Установка: ${targetName()}`); return; }
  const pristine = !dirty || !S.nodes.length;
  const names = fresh.map(a => a.fields.name).join(', ');
  const ok = await ask(`В «${targetName()}» уже есть ${plural(fresh.length, 'агент', 'агента', 'агентов')}: ${names}. Загрузить их на холст, чтобы дополнить систему?`
    + (pristine && S.nodes.length ? ' Шаблон с холста уберу.' : ''), 'Загрузить');
  if (!ok) return;
  if (pristine) { S = emptySystem(target); S.name = targetName(); $('#system-name').value = S.name; }
  importAgents(fresh, meta);
}

// ---------- окна ----------

function openModal(title, body, buttons, size = '') {
  closeModal();
  closeRoleMenu();
  const back = el('div', { class: 'modal-back', onpointerdown: e => { if (e.target === back) closeModal(); } },
    el('div', { class: `modal ${size}`, role: 'dialog', 'aria-label': title },
      el('div', { class: 'modal-head' }, title),
      el('div', { class: 'modal-body' }, body),
      el('div', { class: 'modal-foot' }, buttons)));
  $('#modal-root').append(back);
}

function closeModal() { $('#modal-root').textContent = ''; }

function ask(text, okLabel = 'Продолжить') {
  return new Promise(resolve => {
    openModal('Подтвердите', el('p', { style: 'margin:4px 0 8px' }, text), [
      el('button', { class: 'btn', onclick: () => { closeModal(); resolve(false); } }, 'Отмена'),
      el('button', { class: 'btn primary', onclick: () => { closeModal(); resolve(true); } }, okLabel),
    ]);
  });
}

async function confirmDiscard() {
  if (!dirty || !S.nodes.length) return true;
  return ask('На холсте есть несохранённые изменения, они пропадут.', 'Всё равно открыть');
}

function afterLoad() {
  $('#system-name').value = S.name;
  sel = null;
  renderCanvas();
  renderStatus();
  renderInspector();
  fitView();
  saveDraft();
}

function loadTemplate(t, initial = false) {
  const sys = emptySystem(S.target);
  sys.name = t.name;
  for (const [role, name] of t.agents) {
    const cfg = normCfg(clone(ROLES[role].cfg));
    if (name) cfg.name = name;
    cfg.color = pickColor(cfg.color, sys.nodes);
    sys.nodes.push({ id: uid(), role, x: 0, y: 0, cfg });
  }
  sys.edges = t.edges.map(([a, b]) => ({ from: sys.nodes[a].id, to: sys.nodes[b].id }));
  sys.entry = sys.nodes[0].id;
  S = sys;
  layout();
  dirty = !initial;
  if (!initial) afterLoad();
}

function openDialog() {
  const body = el('div', {},
    el('h2', {}, 'Шаблоны'),
    TEMPLATES.map(t => el('div', {
      class: 'card',
      onclick: async () => { closeModal(); if (await confirmDiscard()) loadTemplate(t); },
    }, el('div', { class: 'grow' }, el('b', {}, t.name), el('small', {}, t.about)),
    el('div', { class: 'tpl-dots', title: plural(t.agents.length, 'агент', 'агента', 'агентов') },
      t.agents.map(([role]) => el('i', { style: `--c:var(--c-${ROLES[role].cfg.color})` }))))),
    el('h2', { style: 'margin-top:18px' }, 'Сохранённые системы'),
    env.systems.length
      ? env.systems.map(s => el('div', {
        class: 'card',
        onclick: async () => {
          closeModal();
          if (!(await confirmDiscard())) return;
          try { S = normSystem(await api('/api/systems/load', { id: s.id })); dirty = false; afterLoad(); }
          catch (err) { toast(err.message, 'err'); }
        },
      }, el('div', { class: 'grow' }, el('b', {}, s.name), el('small', {}, `${plural(s.agents, 'агент', 'агента', 'агентов')} · ${s.updated}`)),
      el('button', {
        class: 'mini', title: 'Удалить систему',
        onclick: async ev => {
          ev.stopPropagation();
          if (!(await ask(`Удалить систему «${s.name}»? Установленные агенты останутся на месте.`, 'Удалить'))) return;
          try { env.systems = (await api('/api/systems/delete', { id: s.id })).systems; toast('Система удалена'); }
          catch (err) { toast(err.message, 'err'); }
        },
      }, '×')))
      : el('div', { class: 'list-empty' }, 'Пока пусто. Кнопка «Сохранить» сохранит систему с холста.'));
  openModal('Открыть', body, [el('button', { class: 'btn', onclick: closeModal }, 'Закрыть')]);
}

async function saveSystem(silent = false) {
  if (!S.name.trim()) { toast('Дайте системе название', 'err'); $('#system-name').focus(); return false; }
  try {
    const r = await api('/api/systems/save', S);
    env.systems = r.systems;
    dirty = false;
    renderStatus();
    saveDraft();
    if (!silent) toast(`Сохранено в systems/${r.id}.json`);
    return true;
  } catch (e) {
    toast(e.message, 'err');
    return false;
  }
}

// ---------- импорт ----------

function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('(['.includes(ch)) depth++;
    else if (')]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function nodeFromParsed(a) {
  const f = a.fields, cfg = normCfg({});
  cfg.name = slugName(f.name, true) || 'agent';
  cfg.description = f.description || '';
  cfg.model = f.model || '';
  cfg.effort = f.effort || '';
  cfg.permissionMode = f.permissionMode || '';
  cfg.maxTurns = f.maxTurns ? String(f.maxTurns) : '';
  cfg.memory = f.memory || '';
  cfg.skills = Array.isArray(f.skills) ? f.skills : f.skills ? [f.skills] : [];
  cfg.prompt = a.prompt || '';
  cfg.teamSection = a.teamSection !== false;
  cfg.extraYaml = a.extraYaml || '';
  let kids = [];
  const list = Array.isArray(f.tools) ? f.tools : f.tools ? splitTop(f.tools) : null;
  if (!list) cfg.toolsMode = 'inherit';
  else {
    const extra = [];
    for (const t of list) {
      const m = /^Agent\((.*)\)$/.exec(t);
      if (m) kids = m[1].split(',').map(x => x.trim()).filter(Boolean);
      else if (ALL_TOOLS.includes(t)) cfg.tools.push(t);
      else extra.push(t);
    }
    cfg.extraTools = extra.join(', ');
  }
  const role = ROLES[cfg.name] ? cfg.name : ROLES[cfg.name.replace(/-\d+$/, '')] ? cfg.name.replace(/-\d+$/, '') : 'custom';
  cfg.color = COLORS.includes(f.color) ? f.color : pickColor(ROLES[role].cfg.color);
  return { node: { id: uid(), role, x: 0, y: 0, cfg }, kids };
}

async function importDialog() {
  let list, meta;
  try { meta = await api('/api/agents', { target: S.target }); list = meta.agents; }
  catch (e) { toast(e.message, 'err'); return; }
  const where = targetDir();
  const close = el('button', { class: 'btn', onclick: closeModal }, 'Закрыть');
  if (!list.length) {
    openModal('Импорт агентов', el('p', {}, `В ${where} агентов пока нет. Место установки меняется в настройках системы.`), [close]);
    return;
  }
  const onCanvas = new Set(S.nodes.map(n => n.cfg.name));
  const chosen = new Set(list.map(a => a.fields.name).filter(n => !onCanvas.has(n)));
  const body = el('div', {},
    el('p', { class: 'hint', style: 'margin-top:0' }, `Найдено в ${where}. Связи восстановятся по полю tools.`),
    el('div', { class: 'list' }, list.map(a => {
      const nm = a.fields.name, dup = onCanvas.has(nm);
      return el('label', { class: 'list-item check' },
        el('input', { type: 'checkbox', checked: !dup, disabled: dup, onchange: e => toggleSet(chosen, nm, e.target.checked) }),
        el('span', { class: 'name' }, nm),
        el('small', { class: 'hint', style: 'margin:0;flex:2' }, dup ? 'уже на холсте' : oneLine(a.fields.description).slice(0, 70)));
    })));
  openModal('Импорт агентов', body, [
    el('button', { class: 'btn', onclick: closeModal }, 'Отмена'),
    el('button', { class: 'btn primary', onclick: () => { closeModal(); importAgents(list.filter(a => chosen.has(a.fields.name)), meta); } }, 'Добавить на холст'),
  ]);
}

function importAgents(list, meta = {}) {
  if (!list.length) return;
  const wasEmpty = !S.nodes.length;
  const created = list.map(nodeFromParsed);
  for (const { node } of created) S.nodes.push(node);
  for (const { node, kids } of created) {
    for (const k of kids) {
      const t = S.nodes.find(n => n.cfg.name === k);
      if (t && t.id !== node.id && !findEdge(node.id, t.id)) S.edges.push({ from: node.id, to: t.id });
    }
  }
  // Все агенты из одной установленной системы — продолжаем её, а не заводим новую:
  // тогда при следующей установке удалённые с холста агенты уберутся и из папки.
  const systems = new Set(list.map(a => a.system));
  if (wasEmpty && systems.size === 1 && list[0].system) {
    S.id = list[0].system;
    S.name = list[0].systemName || S.name;
    $('#system-name').value = S.name;
  }
  const mainAgent = meta.settingsAgent && S.nodes.find(n => n.cfg.name === meta.settingsAgent);
  if (mainAgent) { S.entry = mainAgent.id; S.entryInSettings = true; }
  if (!byId(S.entry)) {
    const mine = created.map(c => c.node);
    S.entry = (roots().find(n => mine.includes(n) && kidsOf(n.id).length) || mine[0]).id;
  }
  if (wasEmpty) layout();
  else {
    const others = S.nodes.filter(n => !created.some(c => c.node === n));
    const x0 = Math.max(...others.map(n => n.x)) + 320;
    created.forEach(({ node }, i) => { node.x = x0; node.y = i * ROW_GAP; });
  }
  sel = null;
  changed(true);
  fitView();
  toast(`На холст добавлено: ${plural(created.length, 'агент', 'агента', 'агентов')}`);
}

// ---------- установка ----------

const ACTION = {
  create: 'создать', update: 'обновить', same: 'без изменений',
  overwrite: 'перезаписать', conflict: 'уже есть', remove: 'удалить',
};

async function install() {
  const issues = validate();
  if (!S.nodes.length) { toast('Сначала добавьте агентов', 'err'); return; }
  if (issues.some(i => i.level === 'err')) { setSel(null); toast('Сначала исправьте ошибки в разделе «Проверка»', 'err'); return; }
  const req = {
    target: S.target, system: S.id, systemName: S.name,
    files: S.nodes.map(n => ({ name: n.cfg.name, content: buildMd(n) })),
    entry: byId(S.entry)?.cfg.name || null,
    entryInSettings: S.target.scope === 'project' && S.entryInSettings,
  };
  let plan;
  try { plan = await api('/api/install', { ...req, dryRun: true }); }
  catch (e) { toast(e.message, 'err'); return; }
  showPlan(req, plan);
}

function showPlan(req, plan) {
  const overwrite = new Set();
  const s = plan.settings;
  const nothing = plan.plan.every(p => p.action === 'same') && !s;
  const body = el('div', {},
    el('div', { class: 'path' }, plan.agentsDir),
    el('div', { style: 'margin-top:8px' }, plan.plan.map(p => el('div', { class: 'plan-row' },
      el('span', { class: 'name' }, `${p.name}.md`, p.note ? el('span', { class: 'note' }, p.note) : null),
      p.action === 'conflict' ? el('label', { class: 'check' },
        el('input', { type: 'checkbox', onchange: e => toggleSet(overwrite, p.name, e.target.checked) }),
        el('span', {}, 'перезаписать')) : null,
      el('span', { class: `tag ${p.action}` }, ACTION[p.action]))),
    s ? el('div', { class: 'plan-row' },
      el('span', { class: 'name' }, '.claude/settings.json',
        el('span', { class: 'note' }, s.to ? `"agent": "${s.to}"${s.from ? ` вместо "${s.from}"` : ''}` : `убрать "agent": "${s.from}"`)),
      el('span', { class: 'tag update' }, 'изменить')) : null),
    nothing ? el('div', { class: 'note-box' }, 'Всё уже установлено, менять нечего.') : null,
    plan.plan.some(p => p.action === 'conflict')
      ? el('div', { class: 'note-box' }, 'Файлы с пометкой «уже есть» созданы не конструктором. Без галочки я их не трону.') : null,
    !plan.dirExists
      ? el('div', { class: 'note-box' }, 'Папки агентов ещё нет. После установки перезапустите Claude Code, чтобы он её увидел.') : null,
    nothing ? null : el('p', { class: 'hint' }, 'Прежде чем изменить или удалить файл, сохраню копию в папку backups/ рядом с конструктором.'));
  openModal('Установка', body, nothing
    ? [el('button', { class: 'btn primary', onclick: closeModal }, 'Закрыть')]
    : [el('button', { class: 'btn', onclick: closeModal }, 'Отмена'),
      el('button', { class: 'btn primary', onclick: () => applyInstall(req, overwrite, plan.dirExists) }, 'Установить')]);
}

async function applyInstall(req, overwrite, dirExisted) {
  let res;
  try { res = await api('/api/install', { ...req, overwrite: [...overwrite] }); }
  catch (e) { toast(e.message, 'err'); return; }
  closeModal();
  projectsCache = null;  // число агентов в проектах изменилось
  try { env = Object.assign(env, await api('/api/env')); } catch { /* не критично */ }
  await saveSystem(true);
  const count = (...acts) => res.plan.filter(p => acts.includes(p.action)).length;
  const parts = [
    [count('create'), 'создано'], [count('update', 'overwrite'), 'обновлено'],
    [count('remove'), 'удалено'], [count('same'), 'без изменений'], [count('conflict'), 'пропущено'],
  ].filter(([n]) => n).map(([n, t]) => `${t}: ${n}`);
  openModal('Готово', el('div', {},
    el('p', { style: 'margin-top:0' }, `Агенты установлены в ${res.agentsDir}. ${parts.join(', ')}.`),
    res.settings ? el('p', {}, 'Настройки проекта обновлены.') : null,
    res.backupDir ? el('p', { class: 'hint' }, 'Прежние версии файлов: ', el('span', { class: 'path' }, res.backupDir)) : null,
    !dirExisted ? el('div', { class: 'note-box' }, 'Папка агентов создана впервые: перезапустите Claude Code, чтобы он её подхватил. Дальше изменения подхватываются сами.') : null,
    el('h2', { style: 'margin-top:14px' }, 'Как запустить'),
    howtoBlock()),
  [el('button', { class: 'btn primary', onclick: closeModal }, 'Понятно')]);
  refreshLive();
}

// ---------- черновик ----------

// Черновик холста пишется и в браузер, и в draft.json рядом с конструктором:
// так он переживает перезапуск сервера и смену порта.
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}

function flushDraft() {
  clearTimeout(draftTimer);
  const d = { S, dirty, savedAt: Date.now() };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* хранилище недоступно */ }
  if (!reloading) api('/api/draft/save', d).catch(() => { /* не критично: копия есть в браузере */ });
}

function parseDraft(d) {
  return d && d.S ? { S: normSystem(d.S), dirty: !!d.dirty, savedAt: d.savedAt || 0 } : null;
}

async function loadDraft() {
  let local = null, remote = null;
  try { local = parseDraft(JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')); } catch { /* повреждённый черновик */ }
  try { remote = parseDraft((await api('/api/draft/load', {})).draft); } catch { /* сервер недоступен */ }
  if (local && remote) return remote.savedAt >= local.savedAt ? remote : local;
  return remote || local;
}

// ---------- запуск ----------

function bindTopbar() {
  $('#system-name').addEventListener('input', e => {
    S.name = e.target.value;
    if (!sel) setTitle(S.name || 'Без названия');
    changed();
  });
  $('#btn-new').onclick = async () => {
    if (!(await confirmDiscard())) return;
    S = emptySystem(S.target);
    dirty = false;
    afterLoad();
  };
  $('#btn-open').onclick = openDialog;
  $('#empty-open').onclick = openDialog;
  $('#btn-import').onclick = importDialog;
  $('#btn-save').onclick = () => saveSystem();
  $('#btn-install').onclick = install;
  $('#status').onclick = () => setSel(null);
  $('#target-chip').onclick = openTargetPicker;
  $('#fab-add').onclick = addFromFab;
  $('#empty-add').onclick = addFromFab;
  $('#zoom-in').onclick = () => zoomCenter(1.2);
  $('#zoom-out').onclick = () => zoomCenter(1 / 1.2);
  $('#zoom-reset').onclick = () => zoomCenter(1 / view.k);
  $('#fit').onclick = fitView;
  $('#layout').onclick = () => { layout(); changed(); fitView(); };
}

async function init() {
  initMarkers();
  bindTopbar();
  const draft = await loadDraft();
  if (draft) { S = draft.S; dirty = draft.dirty; } else loadTemplate(TEMPLATES[0], true);
  if (draft) flushDraft();  // перенесёт черновик из браузера на диск, если его там ещё нет
  $('#system-name').value = S.name;
  renderCanvas();
  renderStatus();
  renderInspector();
  fitView();
  try {
    env = Object.assign(env, await api('/api/env'));
    renderInspector();
    renderTargetChip();
  } catch (e) {
    toast(e.message, 'err');
  }
  // Пока вкладка открыта, сервер знает, что им пользуются, и не выключается.
  setInterval(() => api('/api/heartbeat', {}).catch(() => { /* сообщим при следующем действии */ }), 60000);
}

init();
