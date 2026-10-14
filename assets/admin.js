/* admin.js —— 管理后台逻辑（纯前端，数据存浏览器 IndexedDB） */
function fmt(n) { return Number(n).toFixed(2); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function today() { return new Date().toISOString().slice(0, 10); }
const MAX = 5 * 1024 * 1024;

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    if (file.size > MAX) return rej(new Error('附件超过 5MB 上限'));
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

async function refreshNav() {
  const u = Store.getSession();
  const nav = document.getElementById('adminNav');
  if (!u) { nav.innerHTML = ''; return; }
  let html = '<a href="index.html">公开浏览</a><a href="admin.html">管理后台</a>';
  if (Store.isSuper()) html += '<a href="#" onclick="goto(\'users\')">管理员管理</a><a href="#" onclick="goto(\'logs\')">操作日志</a>';
  html += '<a href="#" onclick="changePwView()">修改密码</a>';
  html += '<span class="me">管理员：' + esc(u) + (Store.isSuper() ? '（超管）' : '') + ' · <a href="#" onclick="logout()">退出</a></span>';
  nav.innerHTML = html;
}

function goto(view) {
  document.getElementById('panelUsers').classList.toggle('hidden', view !== 'users');
  document.getElementById('panelLogs').classList.toggle('hidden', view !== 'logs');
  document.getElementById('panelMain').classList.toggle('hidden', view !== 'main');
  document.getElementById('panelPw').classList.add('hidden');
  if (view === 'users') renderUsers();
  if (view === 'logs') renderLogs();
}

function showFlash(msg, ok) {
  const f = document.getElementById('flash');
  f.textContent = msg; f.className = 'flash ' + (ok ? 'ok' : 'warn');
  f.classList.remove('hidden');
  setTimeout(() => f.classList.add('hidden'), 3500);
}

async function login() {
  const u = document.getElementById('lu').value.trim();
  const p = document.getElementById('lp').value;
  const user = await Store.getUser(u);
  if (user && !user.disabled && (await Store.hashPassword(p)) === user.hash) {
    Store.setSession(u); await Store.addLog(u, '登录成功'); showDash();
  } else { showFlash('账号或密码错误', false); }
}
function logout() {
  const u = Store.getSession();
  if (u) Store.addLog(u, '退出登录');
  Store.clearSession(); showLogin();
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
  refreshNav();
}

async function renderMain() {
  const u = Store.getSession();
  const all = await Store.listRecords();
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
  Store.getRecord(id).then(r => { if (r && r.attachment) { const w = window.open(''); w.document.write('<title>佐证</title><body style="margin:0"><img style="max-width:100%" src="' + r.attachment + '"></body>'); } });
}

async function doAdd() {
  const date = document.getElementById('aDate').value, type = document.getElementById('aType').value,
    amount = parseFloat(document.getElementById('aAmt').value),
    desc = document.getElementById('aDesc').value.trim(), handler = document.getElementById('aHandler').value.trim();
  if (!date || !desc || !handler || !(amount > 0)) return showFlash('请完整填写日期/类型/金额/事项/经办人', false);
  const f = document.getElementById('aAtt').files[0];
  if (!f) return showFlash('佐证附件为必填项，请上传', false);
  let data;
  try { data = await fileToDataURL(f); } catch (e) { return showFlash(e.message, false); }
  await Store.addRecord({ date, type, amount, desc, handler, attachment: data, created_by: Store.getSession() });
  showFlash('记录已保存（含佐证附件）', true);
  document.getElementById('aForm').reset(); document.getElementById('aDate').value = today();
  await renderMain();
}

async function openEdit(id) {
  const r = await Store.getRecord(id);
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
  const r = await Store.getRecord(id);
  if (r.created_by !== Store.getSession()) return showFlash('只能修改自己的记录', false);
  r.date = document.getElementById('eDate').value;
  r.type = document.getElementById('eType').value;
  r.amount = parseFloat(document.getElementById('eAmt').value);
  r.desc = document.getElementById('eDesc').value.trim();
  r.handler = document.getElementById('eHandler').value.trim();
  const f = document.getElementById('eAtt').files[0];
  if (f) {
    if (f.size > MAX) return showFlash('附件超过 5MB 上限', false);
    r.attachment = await fileToDataURL(f);
  } else if (!document.getElementById('eKeep').checked) {
    r.attachment = null;
  }
  await Store.updateRecord(r);
  closeEdit(); showFlash('记录已更新', true); await renderMain();
}
async function doDel(id) {
  const r = await Store.getRecord(id);
  if (r.created_by !== Store.getSession()) return showFlash('只能删除自己的记录', false);
  if (!confirm('确定删除该记录？')) return;
  await Store.deleteRecord(r); showFlash('记录已删除', true); await renderMain();
}

async function renderUsers() {
  const users = await Store.listUsers();
  const tb = document.getElementById('userTb'); tb.innerHTML = '';
  for (const u of users) {
    const act = (u.username === Store.getSession())
      ? '<span class="muted">当前账号</span>'
      : '<a class="att-link" onclick="doDelUser(\'' + u.username + '\')">删除</a> <a class="att-link" onclick="doResetPw(\'' + u.username + '\')">重置密码</a>';
    tb.innerHTML += '<tr><td>' + esc(u.username) + (u.username === Store.SUPER ? '（超管）' : '') + '</td><td>' +
      esc(u.display_name || '') + '</td><td>' + esc(u.created_by || '') + '</td><td>' + esc(u.created_at || '') +
      '</td><td>' + act + '</td></tr>';
  }
}
async function doAddUser() {
  const un = document.getElementById('nu').value.trim(), pw = document.getElementById('np').value, dn = document.getElementById('nd').value.trim();
  if (un.length < 3) return showFlash('账号至少3位', false);
  if (pw.length < 6) return showFlash('密码至少6位', false);
  if (await Store.getUser(un)) return showFlash('该账号已存在', false);
  await Store.addUser({ username: un, hash: await Store.hashPassword(pw), display_name: dn || un, created_by: Store.getSession(), created_at: Store.now(), disabled: 0 });
  showFlash('管理员账号已创建', true);
  document.getElementById('nuForm').reset(); renderUsers();
}
async function doDelUser(un) {
  const users = await Store.listUsers();
  if (users.length <= 1) return showFlash('至少保留一个管理员账号', false);
  if (!confirm('删除管理员 ' + un + '？')) return;
  await Store.deleteUser(un); showFlash('已删除管理员 ' + un, true); renderUsers();
}
async function doResetPw(un) {
  const pw = prompt('为 ' + un + ' 设置新密码（至少6位）：');
  if (!pw) return;
  if (pw.length < 6) return showFlash('密码至少6位', false);
  const u = await Store.getUser(un);
  u.hash = await Store.hashPassword(pw);
  await Store.updateUser(u);
  await Store.addLog(Store.getSession(), '重置密码', 'user', un, '账号 ' + un);
  showFlash('已重置 ' + un + ' 密码', true);
}

async function renderLogs() {
  const ls = await Store.listLogs();
  const tb = document.getElementById('logTb'); tb.innerHTML = '';
  if (!ls.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">暂无日志</td></tr>'; return; }
  for (const l of ls) {
    tb.innerHTML += '<tr><td>' + esc(l.created_at) + '</td><td>' + esc(l.actor) + '</td><td>' + esc(l.action) +
      '</td><td>' + esc(l.target_type) + (l.target_id ? ' #' + esc(l.target_id) : '') + '</td><td>' + esc(l.detail) + '</td></tr>';
  }
}

function changePwView() {
  document.getElementById('panelMain').classList.add('hidden');
  document.getElementById('panelUsers').classList.add('hidden');
  document.getElementById('panelLogs').classList.add('hidden');
  document.getElementById('panelPw').classList.remove('hidden');
}
async function doChangePw() {
  const u = await Store.getUser(Store.getSession());
  const old = document.getElementById('oPw').value, n1 = document.getElementById('nPw').value, n2 = document.getElementById('nPw2').value;
  if ((await Store.hashPassword(old)) !== u.hash) return showFlash('原密码错误', false);
  if (n1 !== n2 || n1.length < 6) return showFlash('两次新密码不一致或不足6位', false);
  u.hash = await Store.hashPassword(n1);
  await Store.updateUser(u); await Store.addLog(u.username, '修改密码');
  showFlash('密码已修改', true);
  document.getElementById('pwForm').reset();
  goto('main');
}

document.addEventListener('DOMContentLoaded', async () => {
  await Store.ensureSeed();
  document.getElementById('aDate').value = today();
  document.getElementById('btnLogin').onclick = login;
  document.getElementById('btnAdd').onclick = doAdd;
  document.getElementById('btnCancelEdit').onclick = closeEdit;
  document.getElementById('btnEdit').onclick = doEdit;
  document.getElementById('btnAddUser').onclick = doAddUser;
  document.getElementById('btnChangePw').onclick = doChangePw;
  if (Store.getSession()) showDash(); else showLogin();
});
