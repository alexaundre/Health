# Health — 端到端加密的多设备健康管理

单文件 HTML 健康管理系统，支持多设备同步。**所有数据在浏览器端加密**，服务端只存密文，连服务器管理员都看不到你的数据。

## 功能

- 📋 个人档案、代谢曲线模拟
- 🍎 食物 / 补剂数据库（带 AI 智能补全 - Gemini）
- 🥗 三餐规划 + 宏量计算
- 💊 补剂管理（剂量、溶解性、保存条件）
- 📅 周日程表（运动+饮食+补剂）
- 💤 睡眠记录与建议
- ✅ 待办、🩸 血检、🧠 知识库
- ☁️ **多设备云同步（端到端加密）**

## 架构

```
┌─────────────────────┐         ┌──────────────────────┐
│  浏览器 (index.html) │         │ Cloudflare Worker    │
│                     │         │                      │
│  本地 localStorage   │ ──────► │  /api/register       │
│  AES-GCM 加密 ──────┼────────►│  /api/login          │
│  PBKDF2 派生 key    │         │  /api/sync (GET/PUT) │
│                     │         │                      │
│  enc_key 永不上传    │         │  D1 SQLite           │
└─────────────────────┘         │  - users (auth_hash) │
                                │  - blobs (密文)       │
                                └──────────────────────┘
```

**密钥派生**：
- 用户密码 + 邮箱 → PBKDF2 (200k 轮) → 两个 256-bit key：
  - `auth_key`：上送服务端，仅用于登录验证
  - `enc_key`：永远在浏览器内存里，AES-GCM 加密所有数据
- 服务端永远拿不到 `enc_key`，因此无法解密任何用户数据
- ⚠️ **代价：忘记密码 = 数据永久丢失**（这是端到端加密的本质）

## 部署方案

| 方案 | 适合 | 速度（中国大陆） | 难度 |
|------|------|----------------|------|
| **A. 阿里云香港 + 自建** ⭐ | 国内访问为主 | 30-80ms | 中（一键脚本） |
| B. Cloudflare Pages + Workers | 海外访问为主 | 不稳定 | 简单 |

---

## 方案 A：阿里云香港部署（推荐）

### 准备

- 阿里云轻量应用服务器（香港，2C1G/200Mbps，Ubuntu 22.04 或 24.04）
- 域名一个（本项目用 `futurus.fit`，后端 `sync.futurus.fit`，前端 `app.futurus.fit`）
- DNS A 记录两条都指向服务器 IP

### 一键部署

SSH 到服务器后：

```bash
curl -fsSL https://raw.githubusercontent.com/alexaundre/Health/main/server/deploy.sh | sudo bash
```

脚本会自动：
1. 装 Node.js 20 LTS、Caddy
2. 创建 `health` 系统用户
3. clone 仓库到 `/opt/health-sync`
4. 启动 systemd 服务（开机自启 + 崩溃重启）
5. 配置 Caddy 自动 HTTPS（Let's Encrypt）
6. 部署前端到 `/var/www/health`

### 后续更新

```bash
sudo /opt/health-sync/server/update.sh
```

### 文件位置

| 路径 | 说明 |
|------|------|
| `/opt/health-sync/` | 后端代码 |
| `/opt/health-sync/data/health.db` | SQLite 数据库（**记得定期备份**） |
| `/var/www/health/index.html` | 前端 |
| `/etc/caddy/Caddyfile` | Caddy 配置 |
| `/var/log/health-sync.log` | 后端日志 |
| `/var/log/caddy/` | Caddy 访问日志 |

### 数据备份

```bash
# 简单备份
cp /opt/health-sync/data/health.db ~/health-$(date +%Y%m%d).db

# 或加到 crontab
echo "0 3 * * * cp /opt/health-sync/data/health.db /root/backups/health-\$(date +\%Y\%m\%d).db" | crontab -
```

---

## 方案 B：Cloudflare 部署

### 1. 前端 (Cloudflare Pages)

把这个仓库连到 Cloudflare Pages：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. 选这个仓库，构建配置全留空（纯静态 HTML）
3. 部署完成后会拿到一个 `xxx.pages.dev` 的域名

或者本地直接打开 `index.html` 也行。

### 2. 后端 (Cloudflare Worker + D1)

```bash
cd worker
npm install

# 登录 Cloudflare CLI（首次）
npx wrangler login

# 创建 D1 数据库
npm run db:create
# 输出会包含 database_id，复制它，填到 wrangler.toml 的 database_id 字段

# 初始化表结构
npm run db:init

# 部署 Worker
npm run deploy
# 输出会给你一个 https://health-sync.xxx.workers.dev URL
```

### 3. 在 App 里配置同步

1. 打开 `index.html`（pages.dev 或本地）
2. 点"注册"页签，输入邮箱+密码（密码至少 8 位，**务必牢记**）
3. 进入应用 → 设置 → 云同步 → 填入 Worker URL → 保存
4. 现在每次保存都会自动加密同步到云端
5. 在另一台设备上：打开同一个 URL → 登录（同邮箱+密码）→ 自动拉取数据

## 安全模型

✅ **服务端能看到**：你的邮箱、auth_key 哈希、密文 blob 大小、同步时间
❌ **服务端看不到**：你的密码、加密密钥、任何健康数据明文

✅ **抗服务端被黑**：攻击者拿到 D1 数据库也只有密文
❌ **抗浏览器被黑**：恶意扩展能拿到内存里的 enc_key
❌ **抗忘记密码**：服务端无法重置，数据丢失

## 本地开发

```bash
# Worker 本地运行
cd worker
npm run db:init-local
npm run dev
# 然后在 App 设置里把同步 URL 改成 http://localhost:8787
```

## 文件说明

- `index.html` — 单文件前端（HTML+CSS+JS 全部内联）
- `worker/src/index.js` — Cloudflare Worker 后端
- `worker/schema.sql` — D1 数据库表结构
- `worker/wrangler.toml` — Worker 配置
- `worker/package.json` — Wrangler CLI

## License

MIT
