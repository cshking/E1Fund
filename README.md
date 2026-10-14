# E1栋电梯公共资金收支管理系统（GitHub Pages 共享账本版）

纯前端单页应用，**无需服务器**，可直接托管到 GitHub Pages。
核心改进：**所有住户与管理员读写同一份仓库账本（`data.json`）**，换设备、换人均可实时看到同一笔账目——彻底解决"管理员录入、其他住户看不到"的问题。

- 游客：免登录浏览收支明细、按时间段筛选、导出 Excel、查看佐证附件。
- 管理员：经 **GitHub 设备授权** 登录（无需密码、无需手动粘贴令牌），录入/修改/删除收支记录（佐证附件必填，图片自动压缩），操作日志审计。
- 超管（仓库初始所有者）：可添加/移除其他管理员（按 GitHub 用户名白名单管理）。

## 工作原理（数据如何共享）
- 账本数据存在仓库根目录的 `data.json` 里。
- 游客/住户打开 `index.html` → 直接读取 `raw.githubusercontent.com/<你>/<仓库>/main/data.json`（无需登录，无速率限制）。
- 管理员打开 `admin.html` → 点击"用 GitHub 登录" → 走 GitHub 设备授权拿到令牌 → 经 GitHub API 把新记录写入 `data.json`（带版本冲突自动重试）。
- 写入后，所有住户刷新 `index.html` 即可看到最新数据（GitHub CDN 通常几秒到一两分钟生效）。

## 安全设计
- **不存储任何密码**：管理员身份 = 你的 GitHub 账号（用户名白名单 `admins[]`）。
- **无令牌粘贴、无聊天暴露**：采用 GitHub 官方 Device Flow，浏览器内完成授权，令牌只保存在你自己的浏览器 localStorage。
- 普通管理员只能改/删自己录入的记录；只有超管能管理白名单与查看操作日志。
- 仓库需为 **Public**（设备授权 + raw 读取均依赖公开仓库）。

## 一、一次性准备：创建 GitHub OAuth App
1. 登录 GitHub → 右上角头像 → **Settings → Developer settings → OAuth Apps → New OAuth App**。
2. Application name 随便填（如 `E1Fund Admin`），Homepage URL 填你的 Pages 地址（可稍后补）。
3. **Authorization callback URL**：设备授权流程不需要回调，可填 `https://github.com/login/device`（或任意占位，不影响）。
4. 点 **Register application**，复制页面上的 **Client ID**。
5. 打开本仓库 `assets/config.js`，把 `CLIENT_ID: 'YOUR_OAUTH_APP_CLIENT_ID'` 改成你的 Client ID：
   ```javascript
   window.APP = {
     OWNER: 'cshking',     // 你的 GitHub 用户名
     REPO: 'E1Fund',       // 你的仓库名
     BRANCH: 'main',
     DATA_PATH: 'data.json',
     CLIENT_ID: '你刚复制的ClientID',   // ← 只改这一行
     SCOPE: 'public_repo'
   };
   ```
   > 只需公开 Client ID，无需任何密钥（Secret）。

## 二、发布到 GitHub Pages
1. 把本目录全部文件（`index.html`、`admin.html`、`assets/`、`data.json`、`README.md`）上传到你的仓库（如 `E1Fund`）。
   - 推荐：本地用 Git 提交推送；或 GitHub 网页端直接拖拽上传。
2. 仓库 → **Settings → Pages** → Source 选 **Deploy from a branch** → Branch 选 **main**、目录选 **/ (root)** → 保存。
3. 约 1 分钟后访问：
   - 公开浏览： `https://<用户名>.github.io/<仓库名>/`
   - 管理后台： `https://<用户名>.github.io/<仓库名>/admin.html`

## 三、首次使用
1. 用仓库所有者账号（本例 `cshking`）打开 `admin.html` → "用 GitHub 登录" → 按提示在 GitHub 输入验证码。
2. 登录后即为超管，可开始录入支出、并在"管理员管理"中添加其他管理员的 GitHub 用户名。
3. 被添加的管理员用自己的 GitHub 账号登录即可录入；住户打开首页即可监督。

## 本地预览
建议用本地静态服务器（避免个别浏览器对 `file://` 的限制）：
```
cd 1014V2
python -m http.server 8080
# 浏览器访问 http://localhost:8080/   （管理功能需能访问 github.com）
```

## 附件大小说明
GitHub 单文件（Contents API）上限约 1MB。为保证账本能正常同步：
- 图片附件会在浏览器端自动压缩（最大边 1280px、JPEG 0.82），通常仅数十到数百 KB。
- 非图片（如 PDF）请控制在约 900KB 以内；过大将提示上传失败。

## 文件结构
```
1014V2/
├─ index.html        # 公开浏览页（游客，免登录）
├─ admin.html        # 管理后台（GitHub 设备授权登录）
├─ data.json         # 共享账本数据（8户集资款初始数据，合计273220元）
├─ assets/
│  ├─ config.js      # 仓库/OAuth 配置（需填入 Client ID）
│  ├─ github.js      # 设备授权 + data.json 读写
│  ├─ store.js       # 共享账本核心（记录/管理员白名单/日志）
│  ├─ public.js      # 公开页逻辑（筛选/导出/佐证）
│  ├─ admin.js       # 后台逻辑（登录/录入/多管理员/日志）
│  └─ style.css
└─ README.md
```
