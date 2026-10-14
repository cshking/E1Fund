/* store.js —— 纯前端存储核心（IndexedDB + Web Crypto SHA-256）
   数据保存在访问者自己的浏览器中，无需服务器，可直接托管到 GitHub Pages。 */
(function (global) {
  'use strict';

  const DB_NAME = 'e1fund';
  const DB_VER = 1;
  const SUPER = 'admin';

  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('records'))
          db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('users'))
          db.createObjectStore('users', { keyPath: 'username' });
        if (!db.objectStoreNames.contains('logs'))
          db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return openDB().then(db => db.transaction(store, mode).objectStore(store));
  }
  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function getAll(store) { return tx(store, 'readonly').then(s => reqP(s.getAll())); }
  function getOne(store, key) { return tx(store, 'readonly').then(s => reqP(s.get(key))); }
  function put(store, val) { return tx(store, 'readwrite').then(s => reqP(s.put(val))); }
  function del(store, key) { return tx(store, 'readwrite').then(s => reqP(s.delete(key))); }
  function count(store) { return tx(store, 'readonly').then(s => reqP(s.count())); }

  // —— 密码哈希（SHA-256，不存明文）——
  async function hashPassword(pw) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // —— 初始种子数据 ——
  const SEED_RECORDS = [
    { date: '2026-10-07', type: 'income', amount: 30780, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-402，户主 吴志铎（邓梅香缴款））：电梯安装集资款（33725? 实缴30780）' },
    { date: '2026-10-07', type: 'income', amount: 37525, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-501，户主 赵廷花）：电梯安装集资款（33725+3800）' },
    { date: '2026-10-07', type: 'income', amount: 44270, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-602，户主 潘在文）：电梯安装集资款（40470+3800）' },
    { date: '2026-10-07', type: 'income', amount: 37525, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-502，户主 颜约胜）：电梯安装集资款（33725+3800）' },
    { date: '2026-10-07', type: 'income', amount: 30780, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-401，户主 易家凡）：电梯安装集资款' },
    { date: '2026-10-07', type: 'income', amount: 44270, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-601，户主 付海燕）：电梯安装集资款（40470+3800）' },
    { date: '2026-10-07', type: 'income', amount: 24035, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-301，户主 罗玲茹）：电梯安装集资款' },
    { date: '2026-10-07', type: 'income', amount: 24035, handler: '潘在文（收款人）', attachment: null,
      desc: '电梯安装集资款（户号 E1-302，户主 陈健尔）：电梯安装集资款' }
  ];

  async function ensureSeed() {
    await openDB();
    if (await count('users') === 0) {
      await put('users', { username: SUPER, hash: await hashPassword('admin123'),
        display_name: '系统管理员', created_by: 'init', created_at: now(), disabled: 0 });
    }
    if (await count('records') === 0) {
      for (const r of SEED_RECORDS) {
        r.created_by = SUPER; r.created_at = now();
        await put('records', r);
      }
      await addLog(SUPER, '初始化', 'system', '', '导入8户集资款初始数据，合计273220元');
    }
  }

  function now() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // —— 记录 ——
  async function listRecords() {
    const rs = await getAll('records');
    return rs.sort((a, b) => (b.date === a.date ? b.id - a.id : (b.date > a.date ? 1 : -1)));
  }
  async function getRecord(id) { return getOne('records', id); }
  async function addRecord(rec) {
    rec.created_at = now();
    const id = await reqP((await tx('records', 'readwrite')).add(rec));
    await addLog(rec.created_by, '新增记录', 'record', id,
      (rec.date + ' ' + (rec.type === 'income' ? '收入' : '支出') + ' ' + rec.amount + ' ' + rec.desc.slice(0, 30)));
    return id;
  }
  async function updateRecord(rec) {
    await put('records', rec);
    await addLog(rec.created_by, '修改记录', 'record', rec.id,
      (rec.date + ' ' + (rec.type === 'income' ? '收入' : '支出') + ' ' + rec.amount + ' ' + rec.desc.slice(0, 30)));
  }
  async function deleteRecord(rec) {
    await del('records', rec.id);
    await addLog(rec.created_by, '删除记录', 'record', rec.id, (rec.desc || '').slice(0, 30));
  }

  // —— 用户 ——
  async function listUsers() { return (await getAll('users')).sort((a, b) => a.username.localeCompare(b.username)); }
  async function getUser(u) { return getOne('users', u); }
  async function addUser(u) { await put('users', u); await addLog(u.created_by, '新增管理员', 'user', u.username, '账号 ' + u.username); }
  async function deleteUser(u) { await del('users', u.username); await addLog(SUPER, '删除管理员', 'user', u.username, '账号 ' + u.username); }
  async function updateUser(u) { await put('users', u); }

  // —— 日志 ——
  async function addLog(actor, action, tt, tid, detail) {
    await put('logs', { actor: actor || '游客', action, target_type: tt || '', target_id: (tid === '' ? '' : (tid == null ? '' : String(tid))), detail: detail || '', ip: 'local', created_at: now() });
  }
  async function listLogs() {
    const ls = await getAll('logs');
    return ls.sort((a, b) => b.id - a.id).slice(0, 500);
  }

  // —— 会话（仅存当前登录用户名）——
  function getSession() { return localStorage.getItem('e1fund_session') || ''; }
  function setSession(u) { localStorage.setItem('e1fund_session', u || ''); }
  function clearSession() { localStorage.removeItem('e1fund_session'); }
  function isSuper() { return getSession() === SUPER; }

  global.Store = {
    SUPER, openDB, ensureSeed, hashPassword,
    listRecords, getRecord, addRecord, updateRecord, deleteRecord,
    listUsers, getUser, addUser, deleteUser, updateUser,
    addLog, listLogs,
    getSession, setSession, clearSession, isSuper, now
  };
})(window);
