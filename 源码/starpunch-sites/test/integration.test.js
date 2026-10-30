import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../lib/handler.js';

test('D1 durable attendance, binding, isolation, concurrency and payroll', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_even_argent.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { return sqlite.prepare(sql).get(...args); }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; } }; } };
  const env = { DB, BOOTSTRAP_CODE: 'integration-only' };
  let cookie = '', token = '', machine = 'a'.repeat(64), now = Date.parse('2026-10-06T09:00:00+08:00');
  async function api(route, body, type = 'admin', expected = 200) {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'starpunch' };
    if (type === 'admin' && cookie) headers.Cookie = cookie;
    if (type === 'client') Object.assign(headers, { 'X-Device-Token': token, 'X-Machine-ID': machine });
    const request = new Request('https://example.test' + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const response = await handleRequest(request, env, { now });
    const data = await response.json();
    assert.equal(response.status, expected, route + ': ' + JSON.stringify(data));
    if (response.headers.has('set-cookie')) { assert.match(response.headers.get('set-cookie'), /Secure/); cookie = response.headers.get('set-cookie').split(';')[0]; }
    return data;
  }
  await api('/api/admin/state', undefined, 'public', 401);
  await api('/api/admin/snapshots', undefined, 'public', 401);
  await api('/api/admin/setup', { code: 'wrong', password: 'integration-password' }, 'public', 403);
  await api('/api/admin/setup', { code: env.BOOTSTRAP_CODE, password: 'integration-password' });
  let state = await api('/api/admin/employee', { name: '测试员工', salary: 3000, commissionRate: 10, hireDate: '2026-10-01', pinAction: 'set', pin: '1234' });
  const empId = state.db.employees[0].id;
  await api('/api/admin/employee', { name: '无效员工', salary: 3000, pinAction: 'set', pin: '1' }, 'admin', 400);
  assert.equal((await api('/api/admin/state')).db.employees.length, 1);
  state = await api('/api/admin/employee', { name: '隔离测试员工', salary: 3000, hireDate: '2026-10-01' });
  const otherId = state.db.employees[1].id;
  const { code } = await api('/api/admin/device/code', { empId });
  ({ token } = await api('/api/client/enroll', { code, machineId: machine, machineName: 'Test PC' }, 'public'));
  await api('/api/client/enroll', { code, machineId: 'b'.repeat(64) }, 'public', 403);
  const client = await api('/api/client/state', undefined, 'client');
  assert.deepEqual(client.employees.map(e => e.id), [empId]);
  assert.equal(client.employees[0].pinHash, undefined);
  assert.equal(client.employees[0].cycle.start, '2026-09-15');
  assert.equal(client.employees[0].cycle.end, '2026-10-14');
  assert.equal(client.employees[0].cycle.payDate, '2026-10-15');
  assert.equal(client.employees[0].rate, 100);
  machine = 'b'.repeat(64);
  await api('/api/client/state', undefined, 'client', 401);
  machine = 'a'.repeat(64);
  await api('/api/client/month?emp=' + otherId, undefined, 'client', 403);
  await api('/api/client/punch', { empId: otherId, type: 'in' }, 'client', 403);
  await api('/api/admin/device/code', { empId }, 'admin', 409);
  await api('/api/client/punch', { empId, type: 'in', pin: 'bad' }, 'client', 403);
  const punched = await api('/api/client/punch', { empId, type: 'in', pin: '1234', at: 0 }, 'client');
  assert.equal(punched.at, now);
  await api('/api/client/punch', { empId, type: 'in', pin: '1234' }, 'client', 409);
  now = Date.parse('2026-10-06T15:00:00+08:00');
  await Promise.all([
    api('/api/client/punch', { empId, type: 'done', pin: '1234' }, 'client'),
    api('/api/admin/perf', { empId, date: '2026-10-06', amount: 1000, note: '并发' }),
    api('/api/admin/perf', { empId, date: '2026-10-06', amount: 500, note: '并发2' })
  ]);
  state = await api('/api/admin/state');
  assert.ok(state.db.records[empId + '|2026-10-06'].done);
  assert.equal(state.db.perf.length, 2);
  const originalTimes = {...state.db.records[empId + '|2026-10-06']};
  await api('/api/admin/record', {empId, ds:'2026-10-06', status:'normal', why:'越权'}, 'client', 401);
  await api('/api/admin/record', {empId, ds:'2026-10-06', status:'unknown', why:'非法状态'}, 'admin', 400);
  await api('/api/admin/record', {empId, ds:'2026-10-06', status:'normal'});
  await api('/api/admin/record', {empId, ds:'2026-10-07', status:'normal', why:'未来'}, 'admin', 400);
  await api('/api/admin/record', {empId, ds:'2026-09-30', status:'normal', why:'入职前'}, 'admin', 400);
  for (const [status, amount] of [['normal',100],['late',50],['undone',50],['zero',0],['absent',0]]) {
    state = await api('/api/admin/record', {empId, ds:'2026-10-06', status, why:'直接指定状态'});
    const record = state.db.records[empId + '|2026-10-06'];
    assert.equal(record.in, originalTimes.in); assert.equal(record.done, originalTimes.done);
    assert.equal(record.editLog.at(-1).to.status, status);
    const month = await api('/api/client/month?emp=' + empId + '&ym=2026-10', undefined, 'client');
    const day = month.days.find(d => d.ds === '2026-10-06');
    assert.equal(day.code,status); assert.equal(day.amount,amount); assert.equal(day.manual,true);
    assert.equal(month.summary.base,amount);
    assert.equal((await api('/api/client/state', undefined, 'client')).employees[0].today.code,status);
  }
  await api('/api/client/punch', {empId,type:'in',pin:'1234'}, 'client', 409);
  await api('/api/admin/record', {empId,ds:'2026-10-06',status:'auto',in:'09:00',done:'15:00',why:'恢复自动判断'});
  assert.equal((await api('/api/client/state',undefined,'client')).employees[0].today.manual,false);
  // Manual normal attendance does not invent punch timestamps for an absent day.
  state = await api('/api/admin/record', {empId,ds:'2026-10-05',status:'normal',why:'核实正常出勤'});
  assert.equal(state.db.records[empId + '|2026-10-05'].in,null);
  await api('/api/admin/record', {empId,ds:'2026-10-05',status:'auto',why:'撤销人工指定'});
  await api('/api/admin/record', { empId, ds: '2026-10-06', in: '11:00', done: '15:00', why: '截止边界' });
  now = Date.parse('2026-11-15T00:05:00+08:00');
  await api('/api/system/maintenance', undefined, 'public');
  state = await api('/api/admin/state');
  let payroll = state.db.payrolls.find(p => p.empId === empId && p.period === '2026-10');
  assert.equal(payroll.base, 50); assert.equal(payroll.commission, 150); assert.equal(payroll.amount, 200);
  state = await api('/api/admin/record', {empId,ds:'2026-10-06',status:'normal',why:'未发放重算'});
  assert.equal(state.db.payrolls.find(p=>p.id===payroll.id).amount,250);
  await api('/api/admin/record', {empId,ds:'2026-10-06',status:'late',why:'恢复半薪'});
  await api('/api/admin/payroll/mark', { ids: [payroll.id], paid: true });
  state = await api('/api/admin/record', { empId, ds: '2026-10-06', status:'absent', why: '已发工资锁定' });
  assert.equal(state.db.payrolls.find(p => p.id === payroll.id).amount, 200);
  const backup = await api('/api/admin/backup');
  assert.equal(backup.secrets, undefined); assert.equal(backup.employees[0].pinHash, undefined);
  assert.equal(state.devices[0].tokenHash, undefined); assert.equal(state.devices[0].machineId, undefined);
  await api('/api/admin/logout', {});
  await api('/api/admin/login', { password: 'integration-password' });
  await api('/api/admin/restore', { data: backup });
  assert.equal((await api('/api/admin/state')).db.employees[0].hasPin, true);
  assert.equal((await api('/api/admin/state')).db.records[empId + '|2026-10-06'].manualStatus,'absent');
  await api('/api/admin/device/unbind', { empId });
  await api('/api/client/state', undefined, 'client', 401);
  const next = await api('/api/admin/device/code', { empId });
  ({ token } = await api('/api/client/enroll', { code: next.code, machineId: machine, machineName: 'Test PC' }, 'public'));
  const code2 = await api('/api/admin/device/code', { empId: otherId });
  await api('/api/client/enroll', { code: code2.code, machineId: machine }, 'public', 409);
  now = Date.parse('2026-11-16T00:05:00+08:00');
  await api('/api/system/maintenance', undefined, 'public');
  assert.ok(sqlite.prepare('SELECT day FROM starpunch_backups WHERE day = ?').get('2026-11-16'));
  const snapshots = await api('/api/admin/snapshots');
  assert.ok(snapshots.days.includes('2026-11-16'));
  const historical = await api('/api/admin/snapshots?day=2026-11-16');
  assert.equal(historical.secrets, undefined); assert.equal(historical.employees[0].pinHash, undefined);
  const bulk = {empIds:[empId, otherId], start:'2026-10-01', end:'2026-10-03', status:'normal'};
  await api('/api/admin/records/bulk', bulk, 'client', 401);
  const beforeInvalid = (await api('/api/admin/state')).db.records;
  for (const invalid of [{empIds:[]},{empIds:[empId,'missing']},{start:'2026-02-30'},{start:'2026-10-04'},{end:'2026-12-01'},{status:'invalid'}]) {
    await api('/api/admin/records/bulk', {...bulk,...invalid}, 'admin', invalid.empIds?.includes('missing') ? 404 : 400);
  }
  assert.deepEqual((await api('/api/admin/state')).db.records, beforeInvalid, 'Invalid bulk requests must not partially save');
  state = await api('/api/admin/records/bulk', bulk);
  assert.match(state.msg,/6 条/);
  for (const id of bulk.empIds) for(const day of ['01','02','03']) {
    const record = state.db.records[id + '|2026-10-' + day];
    assert.equal(record.manualStatus,'normal'); assert.equal(record.in,null); assert.equal(record.editLog.at(-1).why,'');
  }
  assert.equal(state.db.payrolls.find(p=>p.id===payroll.id).amount,200,'Paid payroll remains locked in batch');
  assert.equal(state.db.payrolls.find(p=>p.empId===otherId&&p.period==='2026-10').base,300,'Unpaid payroll recalculates once after batch');
  const original = {...state.db.records[empId + '|2026-10-06']};
  state = await api('/api/admin/records/bulk', {empIds:[empId,empId], start:'2026-10-06',end:'2026-10-06',status:'auto'});
  assert.match(state.msg,/1 条/); assert.equal(state.db.records[empId+'|2026-10-06'].manualStatus,undefined);
  assert.equal(state.db.records[empId+'|2026-10-06'].in,original.in); assert.equal(state.db.records[empId+'|2026-10-06'].done,original.done);
  state = await api('/api/admin/records/bulk', {empIds:[empId],start:'2026-09-29',end:'2026-10-01',status:'absent'});
  assert.match(state.msg,/跳过 2 条/); assert.equal(state.db.records[empId+'|2026-09-30'],undefined);
  state = await api('/api/admin/records/bulk', {empIds:[otherId],start:'2026-10-14',end:'2026-10-15',status:'normal'});
  assert.equal(state.db.payrolls.find(p=>p.empId===otherId&&p.payDate==='2026-10-15').base,400);
  assert.equal(state.db.payrolls.find(p=>p.empId===otherId&&p.payDate==='2026-11-15').base,96.77);
  state = await api('/api/admin/perf', {empId:otherId,date:'2026-10-14',amount:200});
  assert.equal(state.db.payrolls.find(p=>p.empId===otherId&&p.payDate==='2026-10-15').perfTotal,200);
  assert.equal(state.db.payrolls.find(p=>p.empId===otherId&&p.payDate==='2026-11-15').perfTotal,0);
  const revision = sqlite.prepare('SELECT revision FROM starpunch_state').get().revision;
  await api('/api/system/maintenance', undefined, 'public');
  assert.equal(sqlite.prepare('SELECT revision FROM starpunch_state').get().revision, revision, 'maintenance is idempotent');
  sqlite.close();
});
