/* store.js —— 共享账本核心（数据存于仓库 data.json，经 GitHub API 读写）
   不再使用浏览器本地存储（IndexedDB）；所有住户与管理员读写同一份仓库数据，实现跨设备/跨人实时同步。
   管理员身份 = GitHub 用户名（白名单 admins[]）；超管 = super 字段。不存储任何密码。 */
window.Store = (function () {
  'use strict';
  const SUPER_DEFAULT = 'cshking';   // 仓库初始化时的超级管理员 GitHub 用户名
  let cache = null;                  // { version, super, admins:[], records:[], logs:[] }

  function isoNow() {
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // —— 仓库尚未存在 data.json 时的初始种子 ——
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

  function seed() {
    const now = isoNow();
    const records = SEED_RECORDS.map((r, i) => Object.assign({ id: i + 1, created_by: SUPER_DEFAULT, created_at: now }, r));
    return {
      version: 1,
      super: SUPER_DEFAULT,
      admins: [SUPER_DEFAULT],
      records,
      logs: [ { id: 1, actor: SUPER_DEFAULT, action: '初始化', target_type: 'system', target_id: '', detail: '导入8户集资款初始数据，合计273220元', ip: 'github', created_at: now } ]
    };
  }

  // —— 读取（游客与管理员共用；管理员写入时 commit() 会重新拉取最新）——
  async function load() {
    if (cache) return cache;
    const d = await GH.readPublic();
    cache = d || seed();
    return cache;
  }
  async function refresh() { cache = null; return load(); }

  function isAdmin(user) {
    if (!cache || !user) return false;
    return (cache.admins || []).indexOf(user) >= 0;
  }
  function isSuper(user) {
    if (!cache || !user) return false;
    return cache.super === user;
  }

  // —— 记录 ——
  function listRecords() {
    return (cache.records || []).slice().sort((a, b) => (b.date === a.date ? b.id - a.id : (b.date > a.date ? 1 : -1)));
  }
  function getRecord(id) { return (cache.records || []).find(r => r.id === id); }

  // 写入：重新拉取最新数据 + sha，应用变更，提交；遇 409 冲突自动重试
  async function commit(message, mutator) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await GH.readWithSha();
      cache = data;
      const working = JSON.parse(JSON.stringify(data));
      mutator(working, GH.getUser());
      try {
        await GH.writeData(working, sha, message);
        cache = working;
        return working;
      } catch (e) {
        lastErr = e;
        if (/HTTP 409/.test(e.message)) { await sleep(900); continue; }
        throw e;
      }
    }
    throw lastErr || new Error('提交失败');
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function pushLog(w, actor, action, tt, tid, detail) {
    if (!w.logs) w.logs = [];
    const id = w.logs.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1;
    w.logs.push({ id, actor: actor || '游客', action, target_type: tt || '', target_id: (tid === '' ? '' : (tid == null ? '' : String(tid))), detail: detail || '', ip: 'github', created_at: isoNow() });
  }

  async function addRecord(rec) {
    const actor = GH.getUser();
    await commit('新增资金记录 by ' + actor, (w) => {
      const id = w.records.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
      rec.id = id; rec.created_at = isoNow();
      w.records.push(rec);
      pushLog(w, rec.created_by, '新增记录', 'record', id, (rec.date + ' ' + (rec.type === 'income' ? '收入' : '支出') + ' ' + rec.amount + ' ' + (rec.desc || '').slice(0, 30)));
    });
  }
  async function updateRecord(rec) {
    const actor = GH.getUser();
    await commit('修改资金记录 #' + rec.id + ' by ' + actor, (w) => {
      const i = w.records.findIndex(r => r.id === rec.id);
      if (i >= 0) { rec.updated_at = isoNow(); w.records[i] = rec; }
      pushLog(w, actor, '修改记录', 'record', rec.id, (rec.date + ' ' + (rec.type === 'income' ? '收入' : '支出') + ' ' + rec.amount + ' ' + (rec.desc || '').slice(0, 30)));
    });
  }
  async function deleteRecord(rec) {
    const actor = GH.getUser();
    await commit('删除资金记录 #' + rec.id + ' by ' + actor, (w) => {
      w.records = w.records.filter(r => r.id !== rec.id);
      pushLog(w, actor, '删除记录', 'record', rec.id, (rec.desc || '').slice(0, 30));
    });
  }

  // —— 管理员白名单（GitHub 用户名）——
  function listAdmins() { return (cache.admins || []).slice(); }
  function getSuper() { return cache.super; }
  async function addAdmin(username, by) {
    await commit('添加管理员 ' + username + ' by ' + by, (w) => {
      if (!w.admins) w.admins = [];
      if (w.admins.indexOf(username) < 0) w.admins.push(username);
      pushLog(w, by, '新增管理员', 'user', username, 'GitHub 账号 ' + username);
    });
  }
  async function removeAdmin(username, by) {
    if (cache.super === username) throw new Error('不能移除超级管理员');
    await commit('移除管理员 ' + username + ' by ' + by, (w) => {
      if (!w.admins || w.admins.length <= 1) throw new Error('至少保留一名管理员');
      w.admins = w.admins.filter(a => a !== username);
      pushLog(w, by, '删除管理员', 'user', username, 'GitHub 账号 ' + username);
    });
  }

  // —— 日志 ——
  function listLogs() {
    return (cache.logs || []).slice().sort((a, b) => b.id - a.id).slice(0, 500);
  }

  return {
    SUPER_DEFAULT, load, refresh, isAdmin, isSuper,
    listRecords, getRecord, addRecord, updateRecord, deleteRecord,
    listAdmins, getSuper, addAdmin, removeAdmin,
    listLogs, isoNow
  };
})();
