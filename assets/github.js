/* github.js —— GitHub 设备授权 + 仓库 data.json 读写（共享账本，无服务器）
   游客/住户：免登录读取仓库里的 data.json（近实时同步）。
   管理员：经 GitHub 设备授权拿到令牌后写入 data.json（无需粘贴令牌、无需存储密码）。 */
window.GH = (function () {
  'use strict';
  const API = 'https://api.github.com';
  const RAW = 'https://raw.githubusercontent.com';
  const TK = 'e1fund_gh_token';   // 登录令牌（仅存本地浏览器）
  const UK = 'e1fund_gh_user';    // 登录的 GitHub 用户名

  const getToken = () => localStorage.getItem(TK) || '';
  const getUser  = () => localStorage.getItem(UK) || '';
  const setAuth  = (t, u) => { localStorage.setItem(TK, t); localStorage.setItem(UK, u); };
  const clearAuth = () => { localStorage.removeItem(TK); localStorage.removeItem(UK); };
  const cfg = () => window.APP;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 游客/任何人都可读取（优先走 raw，无速率限制、无需登录；失败再兜底到 API）
  async function readPublic() {
    const { OWNER, REPO, BRANCH, DATA_PATH } = cfg();
    const rawUrl = `${RAW}/${OWNER}/${REPO}/${BRANCH}/${DATA_PATH}`;
    try {
      const res = await fetch(rawUrl, { cache: 'no-store' });
      if (res.ok) return await res.json();
      if (res.status !== 404) { /* 其他异常，落到 API 兜底 */ }
    } catch (e) { /* CORS/网络失败，落到 API 兜底 */ }
    // 兜底：GitHub API（公开、支持 CORS，但每小时约 60 次未登录限流）
    const apiUrl = `${API}/repos/${OWNER}/${REPO}/contents/${DATA_PATH}?ref=${BRANCH}`;
    const res2 = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
    if (res2.status === 404) return null;
    if (!res2.ok) throw new Error('读取共享数据失败（HTTP ' + res2.status + '）');
    const j = await res2.json();
    const txt = decodeURIComponent(escape(atob(j.content.replace(/\s/g, ''))));
    return JSON.parse(txt);
  }

  // 管理员写入前读取（带 sha，需登录令牌；用于乐观并发控制）
  async function readWithSha() {
    const { OWNER, REPO, BRANCH, DATA_PATH } = cfg();
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${DATA_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: 'Bearer ' + getToken(), Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error('读取共享数据失败（HTTP ' + res.status + '）');
    const j = await res.json();
    const txt = decodeURIComponent(escape(atob(j.content.replace(/\s/g, ''))));
    return { data: JSON.parse(txt), sha: j.sha };
  }

  function b64(obj) {
    const json = JSON.stringify(obj, null, 2);
    return btoa(unescape(encodeURIComponent(json)));
  }

  async function writeData(data, sha, message) {
    const { OWNER, REPO, BRANCH, DATA_PATH } = cfg();
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${DATA_PATH}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + getToken(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message || 'update E1 fund data', content: b64(data), sha, branch: BRANCH })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (e) {}
      if (res.status === 409) throw new Error('HTTP 409'); // 冲突：有人刚提交，重试
      if (res.status === 401) throw new Error('令牌已失效，请重新登录（HTTP 401）');
      if (res.status === 403) throw new Error('无写入权限或被限流（HTTP 403）：' + detail);
      throw new Error('写入失败（HTTP ' + res.status + (detail ? '：' + detail : '') + '）');
    }
    return await res.json();
  }

  // —— GitHub 设备授权流程（无需手动粘贴令牌）——
  async function login(onCode) {
    const { CLIENT_ID, SCOPE } = cfg();
    if (!CLIENT_ID || CLIENT_ID === 'YOUR_OAUTH_APP_CLIENT_ID')
      throw new Error('尚未配置 Client ID：请在 assets/config.js 填入 GitHub OAuth App 的 Client ID');
    const r1 = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE })
    });
    if (!r1.ok) throw new Error('发起授权失败（HTTP ' + r1.status + '）');
    const dev = await r1.json();          // device_code, user_code, verification_uri(_complete), expires_in, interval
    if (onCode) onCode(dev);
    let interval = (dev.interval || 5) * 1000;
    const deadline = Date.now() + (dev.expires_in || 900) * 1000;
    while (Date.now() < deadline) {
      await sleep(interval);
      const r2 = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID, device_code: dev.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      });
      const t = await r2.json();
      if (t.access_token) {
        const user = await getUsername(t.access_token);
        setAuth(t.access_token, user);
        return user;
      }
      if (t.error === 'authorization_pending') continue;
      if (t.error === 'slow_down') { interval += 5000; continue; }
      if (t.error === 'expired_token') throw new Error('授权超时，请重新点击"用 GitHub 登录"');
      if (t.error === 'access_denied') throw new Error('你已取消授权');
      if (t.error) throw new Error('授权失败：' + t.error);
    }
    throw new Error('授权超时，请重新点击"用 GitHub 登录"');
  }

  async function getUsername(token) {
    const res = await fetch(`${API}/user`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('获取 GitHub 账号失败（HTTP ' + res.status + '）');
    return (await res.json()).login;
  }

  return { getToken, getUser, setAuth, clearAuth, readPublic, readWithSha, writeData, login, getUsername };
})();
