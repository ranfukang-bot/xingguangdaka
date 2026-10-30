import { createRuntime } from './runtime.js';

const json = (status, error) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

// A revision check serializes changes across Worker instances; a losing request
// reruns against the committed state before any response is sent to its caller.
export async function handleRequest(request, env, options = {}) {
  if (!env.DB) return json(503, '云端数据库尚未就绪');
  const url = new URL(request.url);
  const snapshotRequest = request.method === 'GET' && url.pathname === '/api/admin/snapshots';
  const runtimeUrl = new URL(url);
  if (snapshotRequest) runtimeUrl.pathname = '/api/admin/state';
  if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json(403, '请求来源不正确');
  let body = {}, bodyBytes = 0;
  if (request.method === 'POST') {
    if (!request.headers.get('content-type')?.includes('application/json')) return json(415, '请使用 JSON 请求');
    const chunks = [];
    const reader = request.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyBytes += value.byteLength;
        if (bodyBytes > 1024 * 1024) { await reader.cancel(); return json(413, '数据太大'); }
        chunks.push(value);
      }
    }
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return json(400, 'JSON 格式不正确'); }
    if (!body || Array.isArray(body) || typeof body !== 'object') return json(400, '请求格式不正确');
  }
  const headers = Object.fromEntries(request.headers);
  headers['x-forwarded-proto'] = url.protocol === 'https:' ? 'https' : 'http';
  headers['x-forwarded-for'] = request.headers.get('cf-connecting-ip') || 'local';
  const req = { method: request.method, headers, body, bodyBytes, socket: { remoteAddress: headers['x-forwarded-for'] } };
  const timestamp = options.now ?? Date.now();
  for (let attempt = 0; attempt < 8; attempt++) {
    let row = await env.DB.prepare('SELECT revision, payload FROM starpunch_state WHERE id = 1').first();
    if (!row) {
      if (!env.BOOTSTRAP_CODE) return json(503, '管理员初始化码尚未配置');
      const initial = createRuntime({}, env.BOOTSTRAP_CODE, timestamp).getState();
      await env.DB.prepare('INSERT OR IGNORE INTO starpunch_state (id, revision, payload) VALUES (1, 0, ?)').bind(JSON.stringify(initial)).run();
      row = await env.DB.prepare('SELECT revision, payload FROM starpunch_state WHERE id = 1').first();
    }
    const before = JSON.parse(row.payload);
    const runtime = createRuntime(structuredClone(before), env.BOOTSTRAP_CODE, timestamp);
    let status = 200, responseHeaders = {}, responseBody = '';
    const res = { writeHead(code, h) { status = code; responseHeaders = h; }, end(value) { responseBody = value; } };
    try { await runtime.run(req, res, runtimeUrl); }
    catch (error) {
      status = runtime.errorCode(error);
      responseHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      responseBody = JSON.stringify({ error: status === 500 ? '服务暂时异常，请稍后重试' : error.message });
      if (status === 500) console.error('Attendance request failed:', error.message);
    }
    const after = runtime.getState();
    // Validation failures must not partially modify attendance or employee data.
    // Failed-login counters still commit so a new Worker cannot reset throttling.
    if (status >= 400) after.db = before.db;
    const payload = JSON.stringify(after);
    if (payload !== row.payload) {
      const result = await env.DB.prepare('UPDATE starpunch_state SET payload = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').bind(payload, row.revision).run();
      if (!result.meta.changes) continue;
    }
    if (status < 400) {
      await env.DB.prepare('INSERT OR IGNORE INTO starpunch_backups (day, payload) VALUES (?, ?)').bind(runtime.day(), JSON.stringify(after.db)).run();
      await env.DB.prepare('DELETE FROM starpunch_backups WHERE day NOT IN (SELECT day FROM starpunch_backups ORDER BY day DESC LIMIT 90)').run();
    }
    if (status < 400 && snapshotRequest) {
      const day = url.searchParams.get('day');
      if (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(400, '日期格式不正确');
        const snapshot = await env.DB.prepare('SELECT payload FROM starpunch_backups WHERE day = ?').bind(day).first();
        if (!snapshot) return json(404, '快照不存在');
        const data = JSON.parse(snapshot.payload);
        delete data.secrets;
        data.employees = data.employees.map(({pinHash, pinSalt, ...e}) => ({...e, hasPin: !!(pinHash || e.pinResetRequired)}));
        return Response.json(data, { headers: { 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="starpunch-${day}.json"` } });
      }
      const snapshots = await env.DB.prepare('SELECT day FROM starpunch_backups ORDER BY day DESC').all();
      return Response.json({ days: snapshots.results.map(x => x.day) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response(responseBody, { status, headers: { ...responseHeaders, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  return json(409, '同时操作较多，请重试');
}
