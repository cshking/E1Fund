/* admin.js —— 管理后台逻辑（GitHub 设备授权登录，数据存仓库 data.json）
   身份 = GitHub 用户名；超管由 data.json 的 super 字段决定；管理员由 admins[] 白名单决定。不存储密码。 */
function fmt(n) { return Number(n).toFixed(2); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function today() { return new Date().toISOString().slice(0, 10); }
const MAX_ATT_BYTES = 900 * 1024;   // GitHub 单文件（Contents API）上限约 1MB，压缩后附件须在此之内

// —— 附件处理：图片客户端压缩（最大边 1280px、JPEG 0.82），非图片直接 base64 并限大小 ——
function readAsDataURL(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('文件读取失败')); fr.readAsDataURL(file); });
}
function approxBytes(dataUrl) { try { return atob(dataUrl.split(',')[1]).length; } catch (e) { return dataUrl.length; } }
function compressImage(file) {
  return new Promise((res, rej) => {
    readAsDataURL(file).then(src => {
      const img = new Image();
      img.onload = () => {
        const max = 1280; let w = img.width, h = img.height;
        if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const out = cv.toDataURL('image/jpeg', 0.82);
        if (approxBytes(out) > MAX_ATT_BYTES) return rej(new Error('图片压缩后仍超过 ' + (MAX_ATT_BYTES / 1024).toFixed(0) + 'KB，请换更小或更清晰的图片'));
        res(out);
      };
      img.onerror = () => rej(new Error('图片解析失败'));
      img.src = src;
    }).catch(rej);
  });
}
async function fileToDataURL(file) {
  if (!file) return null;
  if (file.type.startsWith('image/')) return await compressImage(file);
  const url = await readAsDataURL(file);
  if (approxBytes(url) > MAX_ATT_BYTES) throw new Error('非图片附件过大（' + (approxBytes(url) / 1024).toFixed(0) + 'KB），GitHub 单文件上限约 1MB，请压缩/裁剪后再上传');
  return url;
}

function curUser() { return GH.getUser(); }

async function refreshNav() {
  const u = curUser();
  const nav = document.getElementById('adminNav');
  if (!u) { nav.innerHTML = ''; return; }
  let html = '<a href="index.html">公开浏览</a><a href="admin.html">管理后台</a>';
  if (Store.isSuper(u)) html += '<a href="#" onclick="goto(\'users\')">管理员管理</a><a href="#" onclick="goto(\'logs\')">操作日志</a>';
  html += '<span class="me">GitHub：@' + esc(u) + (Store.isSuper(u) ? '（超管）' : '') + ' · <a href="#" onclick="logout()">退出</a></span>';
  nav.innerHTML = html;
}

function goto(view) {
  document.getElementById('panelUsers').classList.toggle('hidden', view !== 'users');
  document.getElementById('panelLogs').classList.toggle('hidden', view !== 'logs');
  document.getElementById('panelMain').classList.toggle('hidden', view !== 'main');
  if (view === 'users') renderUsers();
  if (view === 'logs') renderLogs();
}

function showFlash(msg, ok) {
  const f = document.getElementById('flash');
  f.textContent = msg; f.className = 'flash ' + (ok ? 'ok' : 'warn');
  f.classList.remove('hidden');
  setTimeout(() => f.classList.add('hidden'), 4000);
}

// —— 登录：GitHub 设备授权 ——
async function githubLogin() {
  if (!GH.getToken()) {
    showFlash('正在发起 GitHub 授权，请按提示在浏览器中输入验证码…', true);
    try {
      await GH.login(onCode);   // 成功后内部已保存令牌与用户名
    } catch (e) {
      showFlash(e.message, false); hideDev(); return;
    }
  }
  const user = curUser();
  try { await Store.load(); } catch (e) { showFlash('读取共享数据失败：' + e.message, false); return; }
  if (!Store.isAdmin(user)) {
    showFlash('GitHub 账号 @' + user + ' 不在管理员白名单中，请联系超管添加', false);
    GH.clearAuth(); hideDev(); showLogin(); return;
  }
  hideDev(); showDash();
}
function onCode(dev) {
  const box = document.getElementById('devBox');
  box.classList.remove('hidden');
  document.getElementById('devCode').textContent = dev.user_code || '——';
  document.getElementById('devUri').textContent = dev.verification_uri || 'https://github.com/login/device';
  const link = document.getElementById('devLink');
  link.href = dev.verification_uri_complete || (dev.verification_uri || 'https://github.com/login/device');
}
function hideDev() { const b = document.getElementById('devBox'); if (b) b.classList.add('hidden'); }

function logout() {
  GH.clearAuth(); showLogin();
}
async function showDash() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('dashView').classList.remove('hidden');
  await refreshNav();
  await renderMain();
  goto('main');
}
function showLogin() {
  document.getElementById('dashView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
  hideDev();
  refreshNav();
}

async function renderMain() {
  const u = curUser();
  const all = Store.listRecords();
  const inc = all.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
  const exp = all.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
  document.getElementById('cInc').textContent = '¥' + fmt(inc);
  document.getElementById('cExp').textContent = '¥' + fmt(exp);
  document.getElementById('cBal').textContent = '¥' + fmt(inc - exp);
  const own = all.filter(r => r.created_by === u);
  const tb = document.getElementById('ownTb'); tb.innerHTML = '';
  if (!own.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">暂无您录入的记录</td></tr>'; return; }
  for (const r of own) {
    const att = r.attachment
      ? '<a class="att-link" onclick="viewAtt(' + r.id + ')">查看佐证</a>'
      : '<span class="att-none">无（初始导入）</span>';
    tb.innerHTML += '<tr><td>' + esc(r.date) + '</td><td><span class="tag ' + r.type + '">' +
      (r.type === 'income' ? '收入' : '支出') + '</span></td><td class="amt">¥' + fmt(r.amount) +
      '</td><td>' + esc(r.desc) + '</td><td>' + esc(r.handler) + '</td><td>' + att +
      ' <a class="att-link" onclick="openEdit(' + r.id + ')">改</a> <a class="att-link" onclick="doDel(' + r.id + ')">删</a></td></tr>';
  }
}
function viewAtt(id) {
  const r = Store.getRecord(id);
  if (r && r.attachment) { const w = window.open(''); w.document.write('<title>佐证</title><body style="margin:0"><img style="max-width:100%" src="' + r.attachment + '"></body>'); }
}

async function doAdd() {
  const date = document.getElementById('aDate').value, type = document.getElementById('aType').value,
    amount = parseFloat(document.getElementById('aAmt').value),
    desc = document.getElementById('aDesc').value.trim(), handler = document.getElementById('aHandler').value.trim();
  if (!date || !desc || !handler || !(amount > 0)) return showFlash('请完整填写日期/类型/金额/事项/经办人', false);
  const f = document.getElementById('aAtt').files[0];
  if (!f) return showFlash('佐证附件为必填项，请上传（图片将自动压缩）', false);
  let data;
  try { data = await fileToDataURL(f); } catch (e) { return showFlash(e.message, false); }
  showFlash('正在提交到 GitHub 仓库…', true);
  try {
    await Store.addRecord({ date, type, amount, desc, handler, attachment: data, created_by: curUser() });
    showFlash('记录已保存（含佐证附件，已同步到共享账本）', true);
    document.getElementById('aForm').reset(); document.getElementById('aDate').value = today();
    await renderMain();
  } catch (e) { showFlash('保存失败：' + e.message, false); }
}

async function openEdit(id) {
  const r = Store.getRecord(id);
  if (!r) return;
  document.getElementById('eId').value = r.id;
  document.getElementById('eDate').value = r.date;
  document.getElementById('eType').value = r.type;
  document.getElementById('eAmt').value = r.amount;
  document.getElementById('eDesc').value = r.desc;
  document.getElementById('eHandler').value = r.handler;
  document.getElementById('eOld').value = r.attachment ? '1' : '0';
  document.getElementById('editModal').classList.remove('hidden');
}
function closeEdit() { document.getElementById('editModal').classList.add('hidden'); }
async function doEdit() {
  const id = parseInt(document.getElementById('eId').value);
  const r = Store.getRecord(id);
  if (r.created_by !== curUser()) return showFlash('只能修改自己的记录', false);
  r.date = document.getElementById('eDate').value;
  r.type = document.getElementById('eType').value;
  r.amount = parseFloat(document.getElementById('eAmt').value);
  r.desc = document.getElementById('eDesc').value.trim();
  r.handler = document.getElementById('eHandler').value.trim();
  const f = document.getElementById('eAtt').files[0];
  if (f) {
    try { r.attachment = await fileToDataURL(f); } catch (e) { return showFlash(e.message, false); }
  } else if (!document.getElementById('eKeep').checked) {
    r.attachment = null;
  }
  showFlash('正在提交到 GitHub 仓库…', true);
  try { await Store.updateRecord(r); closeEdit(); showFlash('记录已更新', true); await renderMain(); }
  catch (e) { showFlash('更新失败：' + e.message, false); }
}
async function doDel(id) {
  const r = Store.getRecord(id);
  if (r.created_by !== curUser()) return showFlash('只能删除自己的记录', false);
  if (!confirm('确定删除该记录？')) return;
  showFlash('正在提交到 GitHub 仓库…', true);
  try { await Store.deleteRecord(r); showFlash('记录已删除', true); await renderMain(); }
  catch (e) { showFlash('删除失败：' + e.message, false); }
}

// —— 管理员白名单管理（仅超管）——
async function renderUsers() {
  const me = curUser();
  const admins = Store.listAdmins();
  const tb = document.getElementById('userTb'); tb.innerHTML = '';
  for (const u of admins) {
    const isSuper = (u === Store.getSuper());
    const act = (u === me)
      ? '<span class="muted">当前账号</span>'
      : (isSuper ? '<span class="muted">超管（不可移除）</span>' : '<a class="att-link" onclick="doDelUser(\'' + u + '\')">移除</a>');
    tb.innerHTML += '<tr><td>@' + esc(u) + (isSuper ? '（超管）' : '') + '</td><td>' +
      (isSuper ? '超级管理员' : '管理员') + '</td><td>' + act + '</td></tr>';
  }
}
async function doAddUser() {
  const un = document.getElementById('nu').value.trim().replace(/^@/, '');
  if (un.length < 1) return showFlash('请填写 GitHub 用户名', false);
  if (Store.listAdmins().indexOf(un) >= 0) return showFlash('该账号已在白名单中', false);
  showFlash('正在提交到 GitHub 仓库…', true);
  try { await Store.addAdmin(un, curUser()); showFlash('已添加管理员 @' + un, true); document.getElementById('nuForm').reset(); renderUsers(); }
  catch (e) { showFlash('添加失败：' + e.message, false); }
}
async function doDelUser(un) {
  if (!confirm('将 @' + un + ' 移出管理员白名单？')) return;
  showFlash('正在提交到 GitHub 仓库…', true);
  try { await Store.removeAdmin(un, curUser()); showFlash('已移除管理员 @' + un, true); renderUsers(); }
  catch (e) { showFlash('移除失败：' + e.message, false); }
}

async function renderLogs() {
  const ls = Store.listLogs();
  const tb = document.getElementById('logTb'); tb.innerHTML = '';
  if (!ls.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">暂无日志</td></tr>'; return; }
  for (const l of ls) {
    tb.innerHTML += '<tr><td>' + esc(l.created_at) + '</td><td>@' + esc(l.actor) + '</td><td>' + esc(l.action) +
      '</td><td>' + esc(l.target_type) + (l.target_id ? ' #' + esc(l.target_id) : '') + '</td><td>' + esc(l.detail) + '</td></tr>';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('aDate').value = today();
  document.getElementById('btnLogin').onclick = githubLogin;
  document.getElementById('btnAdd').onclick = doAdd;
  document.getElementById('btnCancelEdit').onclick = closeEdit;
  document.getElementById('btnEdit').onclick = doEdit;
  document.getElementById('btnAddUser').onclick = doAddUser;
  if (curUser()) {
    try { await Store.load(); if (Store.isAdmin(curUser())) { showDash(); return; } } catch (e) {}
    GH.clearAuth();
  }
  showLogin();
});
