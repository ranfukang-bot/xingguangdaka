import crypto from 'node:crypto';
import R from '../domain/rules.cjs';
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export function createRuntime(snapshot = {}, setupCode = '', timestamp = Date.now()) {
  const now = () => timestamp;
  const TRUST_PROXY = true;
  let boundEmpId = null;
/* ---------------- 工具 ---------------- */
const uid = () => crypto.randomBytes(8).toString('hex');
const KEY_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randCode = (n, a) => Array.from(crypto.randomBytes(n), b => a[b % a.length]).join('');
const newTerminalKey = () => randCode(4, KEY_ALPHA) + '-' + randCode(4, KEY_ALPHA);
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isDs = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const isHM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const isHMS = s => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(s));
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/* ---------------- 数据库（JSON 文件） ---------------- */
function freshDb() {
  return {
    version: 2,
    settings: {
      company: '星光团队', payrollCycleVersion: 1, salary: 3000, commissionRate: 0, payDay: 15,
      inDL: '11:00', taskDL: '16:00', undoneRatio: 0.5, tzOffset: 8,
      installedAt: R.dkey(now(), { tzOffset: 8 })
    },
    secrets: { adminSalt: '', adminHash: '', terminalKey: newTerminalKey(), setupCode: setupCode || '' },
    employees: [], records: {}, perf: [], payrolls: [], badges: {}, audit: []
  };
}
function normalize(d) {
  const f = freshDb();
  delete f.settings.payrollCycleVersion;
  d.settings = Object.assign(f.settings, d.settings || {});
  d.secrets = Object.assign(f.secrets, d.secrets || {});
  for (const k of ['employees', 'perf', 'payrolls', 'audit']) if (!Array.isArray(d[k])) d[k] = [];
  for (const e of d.employees) {
    if (e.hasPin && !e.pinHash) e.pinResetRequired = true;
    delete e.hasPin;
  }
  for (const k of ['records', 'badges']) if (!d[k] || typeof d[k] !== 'object') d[k] = {};
  d.version = 2;
  R.migratePayrollCycles(d, now());
  return d;
}
let db = snapshot.db ? normalize(snapshot.db) : freshDb();
function save() { /* committed by the request's compare-and-swap transaction */ }
function dailyBackup() { /* durable snapshot written after the transaction */ }
function audit(req, action, detail) {
  db.audit.push({ at: now(), ip: ipOf(req), action, detail });
  if (db.audit.length > 5000) db.audit.splice(0, db.audit.length - 5000);
}
function tick() {
  const fresh = R.ensurePayrolls(db, now(), uid);
  if (fresh.length) {
    fresh.forEach(p => { const e = db.employees.find(x => x.id === p.empId); if (e) R.checkBadges(db, e, now()); });
    db.audit.push({ at: now(), ip: 'system', action: '自动结算', detail: `生成 ${fresh.length} 条工资结算（${fresh[0].period}）` });
    save();
  }
  // A quiet day still needs a backup; save() alone only runs after mutations.
  dailyBackup();
}

/* ---------------- HTTP 工具 ---------------- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
function ipOf(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...headers });
  res.end(JSON.stringify(obj));
}
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpErr(code, msg); };
async function readBody(req, limit = 1024 * 1024) {
  if (req.bodyBytes > limit) fail(413, '数据太大');
  return structuredClone(req.body);
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

/* 登录失败限流：同一来源连续失败 8 次锁 10 分钟 */
const fails = new Map(snapshot.fails || []);
function checkLimit(key) { const f = fails.get(key); if (f && f.until > Date.now()) fail(429, '尝试次数太多，请 10 分钟后再试'); }
function addFail(key) { const f = fails.get(key) || { n: 0, until: 0 }; f.n++; if (f.n >= 8) { f.until = Date.now() + 10 * 60e3; f.n = 0; } fails.set(key, f); }

/* 管理员会话 */
const sessions = new Map(snapshot.sessions || []);
const SESSION_MS = 12 * 3600e3;
function isAdmin(req) {
  const t = cookies(req).sp_admin; if (!t) return false;
  const exp = sessions.get(t); if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  sessions.set(t, Date.now() + SESSION_MS); return true;
}
function sessionCookie(req, token, maxAge) {
  const secure = TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sp_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

/* ---------------- 视图数据 ---------------- */
const pubEmp = e => { const { pinHash, pinSalt, ...rest } = e; return { ...rest, hasPin: !!(pinHash || e.pinResetRequired) }; };
const empOf = id => db.employees.find(e => e.id === id);
function lastPayroll(empId) {
  const l = db.payrolls.filter(p => p.empId === empId).sort((a, b) => b.period.localeCompare(a.period))[0];
  return l ? { amount: l.amount, paid: l.paid, period: l.period, cycleStart:l.cycleStart, cycleEnd:l.cycleEnd, payDate: l.payDate } : null;
}
function clientState() {
  const t = now(), st = db.settings, ds = R.dkey(t, st), p = R.parts(t, st);
  return {
    now: t,
    settings: { company: st.company, payDay: st.payDay, inDL: st.inDL, taskDL: st.taskDL, undoneRatio: st.undoneRatio, tzOffset: st.tzOffset },
    nextPayDate: R.nextPayDate(db, t),
    employees: db.employees.filter(e => e.active !== false && e.id === boundEmpId).map(e => {
      const ev = R.evalDay(db, e, ds, t), mc = R.computeMonth(db, e, p.y, p.m, t), cc = R.computeCurrentCycle(db, e, t), rec = ev.rec || {};
      return {
        id: e.id, name: e.name, avatar: e.avatar, hasPin: !!(e.pinHash || e.pinResetRequired),
        today: { code: ev.code, label: ev.label, final: ev.final, ratio: ev.ratio, manual: !!ev.manual, potential: ev.potential || 0, in: rec.in || null, done: rec.done || null },
        cycle: cc, unpaidTotal: R.r2(cc.amount + db.payrolls.filter(x=>x.empId===e.id && !x.paid).reduce((sum,x)=>sum+x.amount,0)),
        rate: R.dailyRate(db,e,ds), month: { days: mc.days, counts: mc.counts, base: mc.base, perfTotal: mc.perfTotal, commissionRate: mc.commissionRate, commission: mc.commission, amount: mc.amount, salary: mc.salary },
        streak: R.calcStreak(db, e, t), badges: db.badges[e.id] || {}, lastPayroll: lastPayroll(e.id)
      };
    })
  };
}
function adminState() {
  const { secrets, ...rest } = db;
  return { now: now(), devices: (secrets.devices || []).map(({tokenHash, machineId, ...d}) => ({...d, machineHint: machineId.slice(0, 12)})), terminalKey: '', db: { ...rest, employees: db.employees.map(pubEmp), audit: db.audit.slice(-500) } };
}

/* ---------------- 旧版（单机版 v1）备份导入 ---------------- */
function convertV1(d) {
  const out = freshDb();
  Object.assign(out.settings, {
    company: d.settings?.company || out.settings.company, salary: +d.settings?.salary || 3000, payDay: +d.settings?.payDay || 15,
    inDL: d.settings?.inDL || '11:00', taskDL: d.settings?.taskDL || '16:00', undoneRatio: d.settings?.undoneRatio ?? 0.5,
    installedAt: d.settings?.installedAt || out.settings.installedAt
  });
  out.employees = (d.employees || []).map(e => {
    const n = { id: e.id, name: e.name, avatar: e.avatar || '😊', salary: +e.salary || 3000, commissionRate: null, hireDate: e.hireDate || '', active: e.active !== false, leftAt: e.leftAt, createdAt: e.createdAt || now() };
    if (e.pin) { n.pinSalt = uid(); n.pinHash = hashPw(e.pin, n.pinSalt); }
    return n;
  });
  out.records = d.records || {};
  out.badges = d.badges || {};
  out.payrolls = (d.payrolls || []).map(p => ({ ...p, days: p.workdays ?? p.days, base: p.amount, perfTotal: 0, commissionRate: 0, commission: 0 }));
  return out;
}

function editRecord(req, b, {preserveTimes = false, deferPayroll = false} = {}) {
  const t = now(), st = db.settings;
        const e = empOf(b.empId) || fail(404, '员工不存在');
        if (!isDs(b.ds)) fail(400, '日期格式不正确');
        if (b.ds > R.dkey(t, st)) fail(400, '不能修改未来的日期');
        if ((e.hireDate && b.ds < e.hireDate) || (e.leftAt && b.ds > e.leftAt)) fail(400, '只能修改员工在职期间的考勤');
        const key = R.recKey(e.id, b.ds), old = db.records[key] || {};
        const status = b.status === undefined ? (old.manualStatus || 'auto') : b.status;
        if (status !== 'auto' && !R.attendanceStatuses(st).some(x => x.code === status)) fail(400, '考勤状态不正确');
        const manual = status !== 'auto';
        if (b.in && !isHMS(b.in)) fail(400, '上班时间格式不正确');
        if (b.done && !isHMS(b.done)) fail(400, '完成时间格式不正确');
        const nin = manual || preserveTimes ? old.in || null : b.in ? R.tsOf(b.ds, b.in, st) : null, ndone = manual || preserveTimes ? old.done || null : b.done ? R.tsOf(b.ds, b.done, st) : null;
        if (ndone && !nin) fail(400, '有完成时间就必须有上班时间');
        if (nin && ndone && ndone < nin) fail(400, '完成时间不能早于上班时间');
        const why = str(b.why, 100);
        const note = str(b.note, 200);
        const log = (old.editLog || []).concat([{ at: t, from: { in: old.in || null, done: old.done || null, status: old.manualStatus || 'auto' }, to: { in: nin, done: ndone, status }, why }]);
        db.records[key] = { in: nin, done: ndone, note: note || undefined, ...(manual ? {manualStatus: status} : {}), edited: true, editLog: log };
        const fmt = v => v ? R.fmtTS(v, st) : '无';
        const label = code => R.attendanceStatuses(st).find(x => x.code === code)?.label || '按打卡时间自动判断';
        audit(req, '补卡/修改考勤', `${e.name} ${b.ds}：状态 ${label(old.manualStatus)}→${label(status)}；上班 ${fmt(old.in)}→${fmt(nin)}，完成 ${fmt(old.done)}→${fmt(ndone)}；原因：${why || '未填写'}`);
        const s = deferPayroll ? null : R.syncPayroll(db, e.id, b.ds, t);
  return s;
}

/* ---------------- 路由 ---------------- */
async function api(req, res, url) {
  const p = url.pathname, method = req.method, t = now(), st = db.settings;
  const ip = ipOf(req);

  /* ---------- 每日结算与快照 ---------- */
  if (p === '/api/system/maintenance' && method === 'GET') { tick(); return send(res, 200, { ok: true }); }

  if (p === '/api/client/enroll' && method === 'POST') {
    checkLimit('enroll:' + ip);
    const b = await readBody(req, 8192);
    if (!/^[a-f0-9]{64}$/.test(b.machineId || '')) fail(400, '请使用星光打卡 EXE 绑定电脑');
    const code = str(b.code, 64).toUpperCase();
    const item = (db.secrets.pairings || []).find(x => safeEq(x.codeHash, digest(code)) && x.expiresAt > t);
    if (!item) { addFail('enroll:' + ip); fail(403, '绑定码不正确、已使用或已过期'); }
    const e = empOf(item.empId);
    if (!e || e.active === false) fail(403, '员工不存在或已停用');
    const devices = db.secrets.devices || [];
    if (devices.some(x => x.empId === e.id || x.machineId === b.machineId)) fail(409, '这位员工或这台电脑已经绑定，请先让管理员解绑');
    const token = crypto.randomBytes(32).toString('hex');
    devices.push({ id: uid(), empId: e.id, machineId: b.machineId, tokenHash: digest(token), name: str(b.machineName, 60), boundAt: t });
    db.secrets.devices = devices;
    db.secrets.pairings = db.secrets.pairings.filter(x => x !== item);
    fails.delete('enroll:' + ip); audit(req, '绑定电脑', e.name + ' · ' + str(b.machineName, 60));
    save(); return send(res, 200, { ok: true, token, employee: pubEmp(e) });
  }
  /* ---------- 员工端 ---------- */
  if (p.startsWith('/api/client/')) {
    checkLimit('term:' + ip);
    const device = (db.secrets.devices || []).find(x => safeEq(x.tokenHash, digest(req.headers['x-device-token'] || '')) && safeEq(x.machineId, req.headers['x-machine-id'] || ''));
    if (!device || !empOf(device.empId) || empOf(device.empId).active === false) { addFail('term:' + ip); fail(401, '这台电脑未绑定、已解绑或员工已停用'); }
    boundEmpId = device.empId;
    tick();
    if (p === '/api/client/state' && method === 'GET') return send(res, 200, clientState());
    if (p === '/api/client/month' && method === 'GET') {
      const e = empOf(url.searchParams.get('emp')); if (!e || e.active === false) fail(404, '员工不存在');
      if (e.id !== boundEmpId) fail(403, '只能查看本机员工的考勤');
      const [y, m] = R.splitDs(url.searchParams.get('ym') || R.dkey(t, st).slice(0, 7));
      const n = R.daysIn(y, m), days = [];
      for (let d = 1; d <= n; d++) {
        const ev = R.evalDay(db, e, R.ymd(y, m, d), t), r = ev.rec || {};
        days.push({ ds: ev.ds, code: ev.code, label: ev.label, final: ev.final, ratio: ev.ratio, manual: !!ev.manual, in: r.in || null, done: r.done || null, note: r.note || '', edited: !!r.edited, amount: ev.final ? R.r2(ev.ratio * R.dailyRate(db,e,ev.ds)) : null });
      }
      return send(res, 200, { now: t, summary: R.computeMonth(db, e, y, m, t), days, payroll: null });
    }
    if (p === '/api/client/punch' && method === 'POST') {
      const b = await readBody(req, 64 * 1024);
      const e = empOf(b.empId); if (!e || e.active === false) fail(404, '员工不存在');
      if (e.id !== boundEmpId) fail(403, '只能为本机绑定员工打卡');
      if (e.pinResetRequired) fail(403, '备份恢复后，请先联系管理员重新设置打卡密码');
      if (e.pinHash) {
        const lk = 'pin:' + ip + ':' + e.id; checkLimit(lk);
        if (!b.pin || hashPw(b.pin, e.pinSalt) !== e.pinHash) { addFail(lk); fail(403, '打卡密码不正确'); }
        fails.delete(lk);
      }
      const ds = R.dkey(t, st), key = R.recKey(e.id, ds), rec = db.records[key] || {};
      if (rec.manualStatus) fail(409, '今天的考勤已由管理员指定，如需继续打卡，请联系管理员改回自动判断');
      if (b.type === 'in') {
        if (rec.in) fail(409, '今天已经打过上班卡啦');
        rec.in = t;
      } else if (b.type === 'done') {
        if (!rec.in) fail(400, '请先打上班卡');
        if (rec.done) fail(409, '今天的任务已经完成打卡啦');
        rec.done = t;
        const note = str(b.note, 200); if (note) rec.note = note;
      } else fail(400, '未知的打卡类型');
      db.records[key] = rec;
      const ev = R.evalDay(db, e, ds, t), newBadges = R.checkBadges(db, e, t);
      const rate = R.dailyRate(db,e,ds);
      save();
      return send(res, 200, { ok: true, at: t, ev: { code: ev.code, label: ev.label, ratio: ev.ratio, final: ev.final }, rate, amount: ev.final ? R.r2(ev.ratio * rate) : 0, newBadges, state: clientState() });
    }
    fail(404, '接口不存在');
  }

  /* ---------- 管理后台：登录 ---------- */
  if (p === '/api/admin/status' && method === 'GET') return send(res, 200, { needsSetup: !db.secrets.adminHash, loggedIn: isAdmin(req), company: st.company });
  if (p === '/api/admin/setup' && method === 'POST') {
    if (db.secrets.adminHash) fail(400, '管理员密码已设置过');
    checkLimit('setup:' + ip);
    const b = await readBody(req, 64 * 1024);
    if (!db.secrets.setupCode || !safeEq(str(b.code, 64), db.secrets.setupCode)) { addFail('setup:' + ip); fail(403, '初始化码不正确，请查看交付说明'); }
    if (String(b.password || '').length < 6) fail(400, '密码至少 6 位');
    db.secrets.adminSalt = uid(); db.secrets.adminHash = hashPw(b.password, db.secrets.adminSalt); db.secrets.setupCode = '';
    audit(req, '初始化', '设置管理员密码'); save();
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }
  if (p === '/api/admin/login' && method === 'POST') {
    checkLimit('login:' + ip);
    const b = await readBody(req, 64 * 1024);
    if (!db.secrets.adminHash || hashPw(b.password || '', db.secrets.adminSalt) !== db.secrets.adminHash) { addFail('login:' + ip); fail(403, '密码不正确'); }
    fails.delete('login:' + ip);
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, Date.now() + SESSION_MS);
    audit(req, '登录', '管理员登录'); save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }
  if (p === '/api/admin/logout' && method === 'POST') {
    sessions.delete(cookies(req).sp_admin);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  /* ---------- 管理后台：需要登录 ---------- */
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) fail(401, '请先登录');
    if (method === 'POST' && req.headers['x-requested-with'] !== 'starpunch') fail(403, '非法请求');
    tick();
    if (p === '/api/admin/state' && method === 'GET') return send(res, 200, adminState());
    if (p === '/api/admin/backup' && method === 'GET') {
      const { secrets, ...rest } = db;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="starpunch-backup-${R.dkey(t, st)}.json"`, ...SEC });
      return res.end(JSON.stringify({ ...rest, employees: db.employees.map(pubEmp), exportedAt: t }, null, 1));
    }
    if (method !== 'POST') fail(404, '接口不存在');
    const b = await readBody(req);
    let msg = 'ok';

    switch (p) {
      case '/api/admin/device/code': {
        const e = empOf(b.empId) || fail(404, '员工不存在');
        if (e.active === false) fail(400, '请先启用员工');
        if ((db.secrets.devices || []).some(x => x.empId === e.id)) fail(409, '这位员工已有绑定电脑，请先解绑');
        const code = randCode(5, KEY_ALPHA) + '-' + randCode(5, KEY_ALPHA);
        db.secrets.pairings = (db.secrets.pairings || []).filter(x => x.empId !== e.id && x.expiresAt > t);
        db.secrets.pairings.push({ empId: e.id, codeHash: digest(code), expiresAt: t + 86400000 });
        audit(req, '生成电脑绑定码', e.name); save();
        return send(res, 200, { ok: true, code, expiresAt: t + 86400000, ...adminState() });
      }
      case '/api/admin/device/unbind': {
        const e = empOf(b.empId) || fail(404, '员工不存在');
        db.secrets.devices = (db.secrets.devices || []).filter(x => x.empId !== e.id);
        db.secrets.pairings = (db.secrets.pairings || []).filter(x => x.empId !== e.id);
        audit(req, '解绑电脑', e.name); break;
      }
      case '/api/admin/employee': {
        const name = str(b.name, 16); if (!name) fail(400, '请填写姓名');
        const salary = +b.salary; if (!(salary >= 0)) fail(400, '月薪格式不正确');
        let cr = b.commissionRate;
        if (cr === '' || cr === null || cr === undefined) cr = null; else { cr = +cr; if (!(cr >= 0 && cr <= 100)) fail(400, '提成比例需在 0–100 之间'); }
        const hireDate = b.hireDate ? (isDs(b.hireDate) ? b.hireDate : fail(400, '入职日期格式不正确')) : '';
        const pin = b.pinAction === 'set' ? str(b.pin, 12) : '';
        if (b.pinAction === 'set' && pin.length < 4) fail(400, '打卡密码至少 4 位');
        let e = b.id ? empOf(b.id) : null;
        if (b.id && !e) fail(404, '员工不存在');
        const isNew = !e;
        if (isNew) { e = { id: uid(), createdAt: t, active: true }; db.employees.push(e); }
        const before = isNew ? null : { salary: e.salary, commissionRate: e.commissionRate };
        Object.assign(e, { name, salary, commissionRate: cr, hireDate, avatar: str(b.avatar, 8) || '😊' });
        if (b.pinAction === 'set') { e.pinSalt = uid(); e.pinHash = hashPw(pin, e.pinSalt); delete e.pinResetRequired; }
        if (b.pinAction === 'clear') { delete e.pinSalt; delete e.pinHash; delete e.pinResetRequired; }
        tick(); db.payrolls.filter(p=>p.empId===e.id && !p.paid).forEach(p=>R.recalcPayroll(db,p,t));
        audit(req, isNew ? '添加员工' : '编辑员工', `${name}：月薪 ${salary}，提成 ${cr == null ? '默认' : cr + '%'}${before ? `（原月薪 ${before.salary}，原提成 ${before.commissionRate == null ? '默认' : before.commissionRate + '%'}）` : ''}${b.pinAction === 'set' ? '，设置了打卡密码' : b.pinAction === 'clear' ? '，清除了打卡密码' : ''}`);
        break;
      }
      case '/api/admin/employee/toggle': {
        const e = empOf(b.id) || fail(404, '员工不存在');
        if (e.active === false) { e.active = true; delete e.leftAt; audit(req, '启用员工', e.name); }
        else { e.active = false; e.leftAt = R.dkey(t, st); audit(req, '停用员工', e.name); }
        break;
      }
      case '/api/admin/employee/delete': {
        const e = empOf(b.id) || fail(404, '员工不存在');
        db.employees = db.employees.filter(x => x.id !== e.id);
        db.secrets.devices = (db.secrets.devices || []).filter(x => x.empId !== e.id);
        db.secrets.pairings = (db.secrets.pairings || []).filter(x => x.empId !== e.id);
        Object.keys(db.records).forEach(k => { if (k.startsWith(e.id + '|')) delete db.records[k]; });
        db.perf = db.perf.filter(x => x.empId !== e.id);
        delete db.badges[e.id];
        audit(req, '删除员工', `${e.name}（打卡与业绩记录已删除，结算记录保留）`);
        break;
      }
      case '/api/admin/record': {
        const s = editRecord(req, b);
        msg = s === 'updated' ? '已同步更新该月结算记录' : s === 'paid' ? '该月工资已发放，结算记录保持不变' : 'ok';
        break;
      }
      case '/api/admin/records/bulk': {
        const ids = Array.isArray(b.empIds) ? [...new Set(b.empIds)] : [];
        if (!ids.length || ids.length > 200) fail(400, '请选择员工（最多 200 位）');
        const employees = ids.map(id => empOf(id) || fail(404, '员工不存在，请刷新后重试'));
        const validDate = ds => isDs(ds) && R.ymd(...R.splitDs(ds)) === ds;
        if (!validDate(b.start) || !validDate(b.end) || b.start > b.end) fail(400, '请选择正确的日期范围');
        if (b.end > R.dkey(t, st)) fail(400, '不能修改未来的日期');
        if (b.status !== 'auto' && !R.attendanceStatuses(st).some(x => x.code === b.status)) fail(400, '考勤状态不正确');
        const first = R.tsOf(b.start, '12:00', st), last = R.tsOf(b.end, '12:00', st);
        const days = Math.round((last - first) / 86400000) + 1;
        if (days > 366) fail(400, '每次请选择不超过 366 天');
        const targets = []; let skipped = 0;
        for (const e of employees) for (let i = 0; i < days; i++) {
          const ds = R.dkey(first + i * 86400000, st);
          if ((e.hireDate && ds < e.hireDate) || (e.leftAt && ds > e.leftAt)) { skipped++; continue; }
          targets.push({e, ds});
        }
        if (!targets.length) fail(400, '所选范围内没有在职日期可修改');
        if (targets.length > 1000) fail(400, '每次最多修改 1000 条考勤，请缩小范围');
        let paid = false; const periods = new Map();
        for (const {e, ds} of targets) {
          const old = db.records[R.recKey(e.id, ds)] || {};
          editRecord(req, {empId:e.id, ds, status:b.status, why:b.why, note:old.note}, {preserveTimes:true, deferPayroll:true});
          const cycle=R.cycleForDate(st,ds);
          periods.set(e.id + '|' + cycle.payDate, {empId:e.id, period:ds});
        }
        for (const {empId, period} of periods.values()) if (R.syncPayroll(db, empId, period, t) === 'paid') paid = true;
        audit(req, '批量修改考勤', `${employees.length} 位员工，${b.start} 至 ${b.end}，修改 ${targets.length} 条，跳过 ${skipped} 条非在职日期`);
        msg = `已修改 ${targets.length} 条考勤${skipped ? `，跳过 ${skipped} 条非在职日期` : ''}${paid ? '；已发放工资保持不变' : ''}`;
        break;
      }
      case '/api/admin/perf': {
        const e = empOf(b.empId) || fail(404, '员工不存在');
        if (!isDs(b.date)) fail(400, '日期格式不正确');
        const amount = R.r2(+b.amount); if (!isFinite(amount) || amount === 0) fail(400, '业绩金额不正确');
        const item = { id: uid(), empId: e.id, date: b.date, amount, note: str(b.note, 100), createdAt: t };
        db.perf.push(item);
        audit(req, '录入业绩', `${e.name} ${b.date}：¥${amount}${item.note ? '（' + item.note + '）' : ''}`);
        const s = R.syncPayroll(db, e.id, b.date, t);
        msg = s === 'updated' ? '已同步更新该月结算记录' : s === 'paid' ? '该月工资已发放，结算记录保持不变' : 'ok';
        break;
      }
      case '/api/admin/perf/delete': {
        const it = db.perf.find(x => x.id === b.id) || fail(404, '记录不存在');
        db.perf = db.perf.filter(x => x.id !== it.id);
        const e = empOf(it.empId);
        audit(req, '删除业绩', `${e ? e.name : it.empId} ${it.date}：¥${it.amount}`);
        R.syncPayroll(db, it.empId, it.date, t);
        break;
      }
      case '/api/admin/payroll/mark': {
        const ids = Array.isArray(b.ids) ? b.ids : [];
        const list = db.payrolls.filter(x => ids.includes(x.id));
        list.forEach(x => { x.paid = !!b.paid; x.paidAt = b.paid ? t : null; });
        R.migratePayrollCycles(db,t); tick();
        db.payrolls.filter(x=>!x.paid).forEach(x=>R.recalcPayroll(db,x,t));
        audit(req, b.paid ? '标记已发放' : '撤销发放', list.map(x => `${x.empName} ${x.period} ¥${x.amount}`).join('；'));
        if (b.paid) list.forEach(x => { const e = empOf(x.empId); if (e) R.checkBadges(db, e, t); });
        break;
      }
      case '/api/admin/payroll/recalc': {
        const x = db.payrolls.find(q => q.id === b.id) || fail(404, '记录不存在');
        if (x.paid) fail(400, '已发放的记录不能重算');
        const before = x.amount; R.recalcPayroll(db, x, t);
        audit(req, '重算工资', `${x.empName} ${x.period}：¥${before} → ¥${x.amount}`);
        break;
      }
      case '/api/admin/settings': {
        const n = {
          company: str(b.company, 20), salary: +b.salary, commissionRate: +b.commissionRate, payDay: +b.payDay,
          inDL: b.inDL, taskDL: b.taskDL, undoneRatio: +b.undoneRatio
        };
        if (!(n.salary >= 0)) fail(400, '默认月薪格式不正确');
        if (!(n.commissionRate >= 0 && n.commissionRate <= 100)) fail(400, '提成比例需在 0–100 之间');
        if (!(Number.isInteger(n.payDay) && n.payDay >= 1 && n.payDay <= 28)) fail(400, '发薪日需在 1–28 之间');
        if (!isHM(n.inDL) || !isHM(n.taskDL)) fail(400, '时间格式不正确');
        if (R.hm(n.taskDL) <= R.hm(n.inDL)) fail(400, '任务截止时间应晚于上班截止时间');
        if (![0, 0.5, 1].includes(n.undoneRatio)) fail(400, '规则选项不正确');
        const diff = Object.keys(n).filter(k => st[k] !== n[k]).map(k => `${k}: ${st[k]} → ${n[k]}`).join('；');
        if(st.payDay !== n.payDay) {
          db.payrollArchive = [...(db.payrollArchive || []), ...db.payrolls.filter(p=>!p.paid).map(p=>({...p,archivedAt:t,archiveReason:'调整发薪日后重算'}))];
          db.payrolls = db.payrolls.filter(p=>p.paid);
        }
        Object.assign(st, n);
        tick(); db.payrolls.filter(p=>!p.paid).forEach(p=>R.recalcPayroll(db,p,t));
        audit(req, '修改设置', diff || '无变化');
        break;
      }
      case '/api/admin/password': {
        if (hashPw(b.old || '', db.secrets.adminSalt) !== db.secrets.adminHash) fail(403, '原密码不正确');
        if (String(b.password || '').length < 6) fail(400, '新密码至少 6 位');
        db.secrets.adminSalt = uid(); db.secrets.adminHash = hashPw(b.password, db.secrets.adminSalt);
        sessions.clear();
        const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, Date.now() + SESSION_MS);
        audit(req, '修改管理员密码', '其他已登录的管理后台已被强制退出'); save();
        return send(res, 200, { ok: true, ...adminState() }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
      }
      case '/api/admin/terminal-key/reset': {
        db.secrets.terminalKey = newTerminalKey(); db.secrets.devices = []; db.secrets.pairings = [];
        audit(req, '更换终端激活码', '所有打卡电脑需要重新输入激活码');
        break;
      }
      case '/api/admin/restore': {
        const d = b.data;
        if (!d || !Array.isArray(d.employees) || typeof d.records !== 'object') fail(400, '备份文件格式不正确');
        const secrets = db.secrets, previousEmployees = db.employees;
        const restored = d.version === 2 ? normalize({ ...d, secrets }) : normalize({ ...convertV1(d), secrets });
        // Browser backups omit password hashes. Same-server restores retain
        // existing PINs; new-server restores require an explicit PIN reset.
        for (const e of restored.employees) {
          const previous = previousEmployees.find(x => x.id === e.id);
          if (e.pinResetRequired && previous && previous.pinHash) {
            e.pinHash = previous.pinHash; e.pinSalt = previous.pinSalt;
            delete e.pinResetRequired;
          }
        }
        db = restored;
        tick();
        audit(req, '从备份恢复', `${db.employees.length} 位员工，${Object.keys(db.records).length} 条打卡记录`);
        break;
      }
      default: fail(404, '接口不存在');
    }
    save();
    return send(res, 200, { ok: true, msg, ...adminState() });
  }
  fail(404, '接口不存在');
}


  return {
    async run(req, res, url) { return api(req, res, url); },
    getState() {
      const time = Date.now();
      return { db, sessions: [...sessions].filter(([,v]) => v > time), fails: [...fails].filter(([,v]) => v.until > time || v.n > 0).slice(-2000) };
    },
    day() { return R.dkey(now(), db.settings); },
    errorCode(e) { return e instanceof HttpErr ? e.code : 500; }
  };
}
