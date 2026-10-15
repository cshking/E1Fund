/* config.js —— 改成您的仓库信息后即可使用 */
window.APP = {
  OWNER: 'cshking',          // GitHub 仓库所有者用户名
  REPO: 'E1Fund',            // 仓库名
  BRANCH: 'main',            // 默认分支
  DATA_PATH: 'data.json',    // 共享数据文件名（放在仓库根）
  // GitHub OAuth App 的 client_id（在 GitHub → Settings → Developer settings → OAuth Apps 新建一个，
  // 无需填 Callback，拿到 Client ID 粘贴到这里）。仅需公开 client_id，无需密钥。
  CLIENT_ID: 'Ov23liX5vuOHJkEJLsmo',
  SCOPE: 'public_repo'        // 公开仓库写权限（足够）
};
