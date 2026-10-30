/*
 * 星光打卡 · 共享规则引擎
 * 服务器（Node.js）和浏览器（员工端 / 管理后台）共用同一份计算逻辑，保证算出来的钱永远一致。
 *
 * 约定：
 * - 所有时间戳都是毫秒（服务器时间）。
 * - 日期一律用 "YYYY-MM-DD" 字符串表示，按 settings.tzOffset（默认 +8 北京时间）换算，
 *   与运行环境的时区无关（服务器放在国外也不会算错日期）。
 * - 没有休息日：每天都需要打卡，日薪 = 月薪 ÷ 工资周期天数；发薪日开始新一期。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = n => String(n).padStart(2, '0');
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const offMs = st => (st && st.tzOffset != null ? +st.tzOffset : 8) * 3600e3;

  function parts(ts, st) {
    const d = new Date(ts + offMs(st));
    const hh = d.getUTCHours(), mi = d.getUTCMinutes(), ss = d.getUTCSeconds();
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), hh, mi, ss, min: hh * 60 + mi + ss / 60 };
  }
  const ymd = (y, m, d) => { const t = new Date(Date.UTC(y, m, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
  const mkey = (y, m) => { const t = new Date(Date.UTC(y, m, 1)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`; };
  const dkey = (ts, st) => { const p = parts(ts, st); return ymd(p.y, p.m, p.d); };
  const splitDs = ds => { const [y, m, d] = String(ds).split('-').map(Number); return [y, m - 1, d || 1]; };
  const dowOf = ds => { const [y, m, d] = splitDs(ds); return new Date(Date.UTC(y, m, d)).getUTCDay(); };
  const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const minOf = (ts, st) => parts(ts, st).min;
  const fmtT = (ts, st) => { const p = parts(ts, st); return `${pad(p.hh)}:${pad(p.mi)}`; };
  const fmtTS = (ts, st) => { const p = parts(ts, st); return `${pad(p.hh)}:${pad(p.mi)}:${pad(p.ss)}`; };
  const fmtDT = (ts, st) => `${dkey(ts, st)} ${fmtTS(ts, st)}`;
  /** 把某天的 "HH:MM[:SS]" 换算成时间戳 */
  const tsOf = (ds, t, st) => { const [y, m, d] = splitDs(ds); const [h, mi, s] = String(t).split(':').map(Number); return Date.UTC(y, m, d, h, mi || 0, s || 0) - offMs(st); };
  const ratioTxt = r => (+r === 1 ? '全薪' : +r === 0.5 ? '半薪' : +r === 0 ? '无薪' : Math.round(r * 100) + '%');
  const recKey = (id, ds) => id + '|' + ds;
  function attendanceStatuses(st) {
    return [
      { code: 'normal', ratio: 1, label: '正常出勤' },
      { code: 'late', ratio: 0.5, label: '迟到 · 半薪' },
      { code: 'undone', ratio: +st.undoneRatio, label: '任务超时 · ' + ratioTxt(st.undoneRatio) },
      { code: 'zero', ratio: 0, label: '迟到且超时 · 无薪' },
      { code: 'absent', ratio: 0, label: '缺勤' }
    ];
  }

  /** 员工的提成比例（百分比）。员工单独设置优先，否则用全局默认。 */
  function commissionRateOf(db, emp) {
    if (emp && emp.commissionRate !== null && emp.commissionRate !== undefined && emp.commissionRate !== '') return +emp.commissionRate;
    return +(db.settings.commissionRate || 0);
  }

  /**
   * 判定某员工某天的出勤结果
   *   正常：上班截止前打卡 且 任务截止前完成 → 100%
   *   迟到：上班截止及之后打卡，任务截止前完成 → 50%
   *   迟到且超时 → 0
   *   准时但任务截止前未完成 → settings.undoneRatio（默认 50%）
   *   没有上班卡 → 缺勤 0
   */
  function evalDay(db, emp, ds, now) {
    const st = db.settings, rec = db.records[recKey(emp.id, ds)] || null;
    const today = dkey(now, st), inDL = hm(st.inDL), tDL = hm(st.taskDL), nowM = minOf(now, st);
    const base = { ds, rec };
    if (emp.hireDate && ds < emp.hireDate) return { ...base, code: 'na', ratio: 0, final: true, label: '未入职' };
    if (emp.leftAt && ds > emp.leftAt) return { ...base, code: 'na', ratio: 0, final: true, label: '已停用' };
    if (ds > today) return { ...base, code: 'future', ratio: 0, final: false, label: '' };
    const override = attendanceStatuses(st).find(x => x.code === rec?.manualStatus);
    if (override) return { ...base, ...override, final: true, manual: true };
    const isToday = ds === today;
    const hasIn = !!(rec && rec.in), hasDone = !!(rec && rec.done);
    const onTime = hasIn && minOf(rec.in, st) < inDL;
    const doneOk = hasDone && minOf(rec.done, st) < tDL;
    if (!hasIn) {
      if (isToday && nowM < tDL) return { ...base, code: 'waiting', ratio: 0, final: false, potential: nowM < inDL ? 1 : 0.5, label: '待打卡' };
      return { ...base, code: 'absent', ratio: 0, final: true, label: '缺勤' };
    }
    if (doneOk) return onTime
      ? { ...base, code: 'normal', ratio: 1, final: true, label: '正常出勤' }
      : { ...base, code: 'late', ratio: 0.5, final: true, label: '迟到 · 半薪' };
    if (isToday && nowM < tDL && !hasDone) return { ...base, code: 'working', ratio: 0, final: false, potential: onTime ? 1 : 0.5, label: '工作中' };
    if (onTime) { const r = +st.undoneRatio; return { ...base, code: 'undone', ratio: r, final: true, label: '任务超时 · ' + ratioTxt(r) }; }
    return { ...base, code: 'zero', ratio: 0, final: true, label: '迟到且超时 · 无薪' };
  }

  const dateCount = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  function cycleForPayDate(st, payDate) {
    const [y, m] = splitDs(payDate), start = ymd(y, m - 1, st.payDay), end = ymd(y, m, st.payDay - 1);
    return { period: payDate.slice(0, 7), start, end, payDate, days: dateCount(start, end) };
  }
  function cycleForDate(st, ds) {
    const [y, m, d] = splitDs(ds);
    return cycleForPayDate(st, ymd(y, m + (d >= +st.payDay ? 1 : 0), st.payDay));
  }
  const currentCycle = (db, now) => cycleForDate(db.settings, dkey(now, db.settings));
  const dailyRate = (db, emp, ds) => (+emp.salary || 0) / cycleForDate(db.settings, ds).days;
  const periodLabel = p => p.cycleStart ? `${p.cycleStart} 至 ${p.cycleEnd}` : p.start ? `${p.start} 至 ${p.end}` : p.period;
  function payrollRange(p) {
    if (p.cycleStart) return {start:p.cycleStart, end:p.cycleEnd};
    const [y,m] = splitDs(p.period);
    return {start:ymd(y,m,1), end:ymd(y,m+1,0)};
  }
  function payrollCovers(p, ds) { const r = payrollRange(p); return ds >= r.start && ds <= r.end; }
  function computeCycle(db, emp, cycle, now) {
    const salary = +emp.salary || 0, rate = salary / cycle.days;
    const counts = {normal:0,late:0,undone:0,zero:0,absent:0,pending:0};
    const covered = (db.payrolls || []).filter(p => p.empId === emp.id && p.paid &&
      (p.payrollBasis === 'legacy-calendar' || p.cycleStart !== cycle.start || p.cycleEnd !== cycle.end));
    const alreadyPaid = ds => covered.some(p => payrollCovers(p,ds));
    const [y,m,d] = splitDs(cycle.start);
    let base = 0, maxBase = 0, eligible = 0, excludedPaidDays = 0;
    for(let i=0;i<cycle.days;i++) {
      const ds = ymd(y,m,d+i), ev = evalDay(db,emp,ds,now);
      if(ev.code === 'na') continue;
      if(alreadyPaid(ds)) {excludedPaidDays++; continue;}
      eligible++;
      if(ev.final) {counts[ev.code]++;base+=ev.ratio*rate;maxBase+=ev.ratio*rate;}
      else if(ev.code === 'future') maxBase+=rate;
      else {counts.pending++;maxBase+=(ev.potential||0)*rate;}
    }
    const perfTotal = r2((db.perf||[]).filter(p=>p.empId===emp.id && p.date>=cycle.start && p.date<=cycle.end && !alreadyPaid(p.date)).reduce((sum,p)=>sum+(+p.amount||0),0));
    const commissionRate=commissionRateOf(db,emp), commission=r2(perfTotal*commissionRate/100);
    return {...cycle, cycleStart:cycle.start, cycleEnd:cycle.end, salary,rate,eligible,excludedPaidDays,counts,base:r2(base),perfTotal,commissionRate,commission,amount:r2(r2(base)+commission),maxPossible:r2(r2(maxBase)+commission)};
  }
  const computeCurrentCycle = (db,emp,now) => computeCycle(db,emp,currentCycle(db,now),now);
  function migratePayrollCycles(db, now) {
    const pending = db.payrolls.filter(p => !p.paid && (!p.cycleStart || p.payrollBasis === 'legacy-calendar'));
    if(pending.length) {
      db.payrollArchive = [...(db.payrollArchive || []), ...pending.map(p=>({...p,archivedAt:now,archiveReason:'改为发薪周期结算'}))];
      db.payrolls = db.payrolls.filter(p=>!pending.includes(p));
    }
    for(const p of db.payrolls) if(!p.cycleStart) {
      const r=payrollRange(p);p.cycleStart=r.start;p.cycleEnd=r.end;p.payrollBasis='legacy-calendar';
    }
    if(db.settings.payrollCycleVersion !== 1) {
      db.settings.payrollCycleVersion=1;
      db.audit.push({at:now,ip:'system',action:'更新工资周期',detail:'改为上次发薪日至本次发薪日前一天；未发放旧结算归档并重算，已发放金额保留'});
    }
  }

  function perfOfMonth(db, empId, y, m) {
    const pk = mkey(y, m);
    return (db.perf || []).filter(p => p.empId === empId && String(p.date).slice(0, 7) === pk);
  }

  /** 日历月报表：每一天使用所属工资周期的日薪，没有统一的月日薪。 */
  function computeMonth(db, emp, y, m, now) {
    const n = daysIn(y, m), salary = +emp.salary || 0;
    const counts = { normal: 0, late: 0, undone: 0, zero: 0, absent: 0, pending: 0 };
    let base = 0, eligible = 0, maxBase = 0;
    for (let i = 1; i <= n; i++) {
      const ev = evalDay(db, emp, ymd(y, m, i), now), dayRate = dailyRate(db, emp, ymd(y, m, i));
      if (ev.code === 'na') continue;
      eligible++;
      if (ev.final) { counts[ev.code]++; base += ev.ratio * dayRate; maxBase += ev.ratio * dayRate; }
      else if (ev.code === 'future') maxBase += dayRate;
      else { counts.pending++; maxBase += (ev.potential || 0) * dayRate; }
    }
    const perfTotal = r2(perfOfMonth(db, emp.id, y, m).reduce((s, p) => s + (+p.amount || 0), 0));
    const commissionRate = commissionRateOf(db, emp);
    const commission = r2(perfTotal * commissionRate / 100);
    return {
      period: mkey(y, m), days: n, eligible, salary, counts,
      base: r2(base), perfTotal, commissionRate, commission,
      amount: r2(r2(base) + commission), maxPossible: r2(r2(maxBase) + commission)
    };
  }

  /** 连续正常出勤天数（今天未定的不算断） */
  function calcStreak(db, emp, now) {
    const [y, m, d] = splitDs(dkey(now, db.settings));
    let n = 0;
    for (let i = 0; i < 1000; i++) {
      const ev = evalDay(db, emp, ymd(y, m, d - i), now);
      if (ev.code === 'normal') n++;
      else if (!ev.final) continue;
      else break;
    }
    return n;
  }

  /** 下一个发薪日（今天就是发薪日则返回今天） */
  function nextPayDate(db, now) {
    const st = db.settings, p = parts(now, st), today = dkey(now, st);
    const cur = ymd(p.y, p.m, st.payDay);
    return today > cur ? ymd(p.y, p.m + 1, st.payDay) : cur;
  }

  function snapPayroll(db, emp, cycle, now, id) {
    const c=computeCycle(db,emp,cycle,now);
    return {...c,id,empId:emp.id,empName:emp.name,avatar:emp.avatar,payrollBasis:'pay-cycle',createdAt:now,paid:false,paidAt:null};
  }
  /** 到发薪日就结清截至前一天的整个周期，不再延后一个月。 */
  function ensurePayrolls(db, now, genId) {
    const today=dkey(now,db.settings),fresh=[];
    for(const emp of db.employees) {
      const recorded=Object.keys(db.records).filter(k=>k.startsWith(emp.id+'|')).map(k=>k.split('|')[1]);
      const performances=(db.perf||[]).filter(p=>p.empId===emp.id).map(p=>p.date);
      const earliest=emp.hireDate || [...recorded,...performances,db.settings.installedAt].filter(Boolean).sort()[0];
      let cycle=cycleForDate(db.settings,earliest);
      for(let guard=0;guard<600 && cycle.payDate<=today;guard++) {
        if(emp.leftAt && cycle.start>emp.leftAt) break;
        if(!db.payrolls.some(p=>p.empId===emp.id && p.payrollBasis==='pay-cycle' && p.cycleStart===cycle.start && p.cycleEnd===cycle.end)) {
          const p=snapPayroll(db,emp,cycle,now,genId());
          if(p.eligible>0) {db.payrolls.push(p);fresh.push(p);}
        }
        const [y,m]=splitDs(cycle.payDate);cycle=cycleForPayDate(db.settings,ymd(y,m+1,db.settings.payDay));
      }
    }
    return fresh;
  }
  function recalcPayroll(db,p,now) {
    const emp=db.employees.find(e=>e.id===p.empId);
    if(!emp || p.paid || p.payrollBasis !== 'pay-cycle') return false;
    const cycle={period:p.period,start:p.cycleStart,end:p.cycleEnd,payDate:p.payDate,days:dateCount(p.cycleStart,p.cycleEnd)};
    Object.assign(p,snapPayroll(db,emp,cycle,now,p.id),{createdAt:p.createdAt,recalcAt:now});return true;
  }
  /** 跨自然月的修改必须命中覆盖该日期的发薪周期。 */
  function syncPayroll(db,empId,ds,now) {
    const list=db.payrolls.filter(p=>p.empId===empId && payrollCovers(p,ds));
    let result=null;
    for(const p of list) {if(p.paid) result='paid';else if(recalcPayroll(db,p,now) && result!=='paid') result='updated';}
    return result;
  }

  const BADGES = [
    { k: 'first', i: '🌱', n: '初来乍到', d: '完成第一次上班打卡' },
    { k: 'early', i: '🐦', n: '早起的鸟儿', d: '9:00 前完成上班打卡' },
    { k: 'firstDone', i: '🎯', n: '使命必达', d: '第一次正常出勤（准时 + 任务按时完成）' },
    { k: 'comeback', i: '🌈', n: '逆风翻盘', d: '迟到后仍在截止前完成任务' },
    { k: 's3', i: '🔥', n: '渐入佳境', d: '连续 3 天正常出勤' },
    { k: 's7', i: '⚡', n: '势不可挡', d: '连续 7 天正常出勤' },
    { k: 's15', i: '💎', n: '钻石意志', d: '连续 15 天正常出勤' },
    { k: 's30', i: '👑', n: '传奇打工人', d: '连续 30 天正常出勤' },
    { k: 't10', i: '🏅', n: '十全十美', d: '累计正常出勤 10 天' },
    { k: 't50', i: '🏆', n: '半百荣耀', d: '累计正常出勤 50 天' },
    { k: 'full', i: '🌟', n: '全勤之星', d: '某个结算月全部正常出勤' }
  ];
  /** 检查并解锁成就，返回新解锁的成就 key 列表（会修改 db.badges） */
  function checkBadges(db, emp, now) {
    const st = db.settings, inDL = hm(st.inDL), tDL = hm(st.taskDL), got = [];
    const recs = Object.entries(db.records).filter(([k]) => k.startsWith(emp.id + '|')).map(([, r]) => r);
    if (recs.some(r => r.in)) got.push('first');
    if (recs.some(r => r.in && minOf(r.in, st) < 9 * 60)) got.push('early');
    const normals = recs.filter(r => r.in && r.done && minOf(r.in, st) < inDL && minOf(r.done, st) < tDL).length;
    if (normals >= 1) got.push('firstDone');
    if (normals >= 10) got.push('t10');
    if (normals >= 50) got.push('t50');
    if (recs.some(r => r.in && r.done && minOf(r.in, st) >= inDL && minOf(r.done, st) < tDL)) got.push('comeback');
    const s = calcStreak(db, emp, now);
    if (s >= 3) got.push('s3'); if (s >= 7) got.push('s7'); if (s >= 15) got.push('s15'); if (s >= 30) got.push('s30');
    if (db.payrolls.some(p => p.empId === emp.id && p.eligible > 0 && p.counts.normal === p.eligible)) got.push('full');
    const mine = db.badges[emp.id] = db.badges[emp.id] || {};
    const newly = got.filter(k => !mine[k]);
    newly.forEach(k => { mine[k] = now; });
    return newly;
  }

  return {
    pad, r2, parts, ymd, mkey, dkey, splitDs, dowOf, daysIn, hm, minOf, fmtT, fmtTS, fmtDT, tsOf, ratioTxt, recKey,
    dateCount, cycleForPayDate, cycleForDate, currentCycle, dailyRate, periodLabel, payrollRange, payrollCovers, computeCycle, computeCurrentCycle, migratePayrollCycles,
    attendanceStatuses, commissionRateOf, evalDay, perfOfMonth, computeMonth, calcStreak, nextPayDate, snapPayroll, ensurePayrolls,
    recalcPayroll, syncPayroll, BADGES, checkBadges
  };
});
