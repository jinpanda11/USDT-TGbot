# TRON USDT 收入分析 Telegram Bot

把原网页版「USDT 链上收入分析」做成 Telegram 机器人，支持 Docker 部署 + GitHub 推送自动构建 + Watchtower 自动更新。

## 功能

- 管理多个 TRON 收款地址（标签）
- 按**北京时间**查询某月 USDT(TRC20) 入账
- 排除自有地址互转
- USDT/CNY 汇率（默认 / 手动 / CoinGecko 实时）
- 导出 CSV
- 按 Telegram 用户隔离数据（`data/users.json`）

## 命令

| 命令 | 说明 |
|------|------|
| `/start` `/help` | 说明 |
| `/setkey <key>` | 设置个人 TronGrid API Key（`clear` 清除） |
| `/add <地址> [标签]` | 添加地址 |
| `/list` | 地址列表 |
| `/del <序号或地址>` | 删除地址 |
| `/query [年] [月]` | 查询月收入（默认当月） |
| `/export [年] [月]` | 查询并导出 CSV |
| `/rate [值\|live\|clear]` | 汇率 |
| `/exclude on\|off` | 排除自转开关 |

示例：

```text
/setkey 你的TronGridKey
/add TXyz... 收款钱包A
/query 2026 7
/export 2026-07
```

## 本地运行

```bash
cp .env.example .env
# 编辑 .env，填入 TELEGRAM_BOT_TOKEN

npm install
npm start
```

## Docker + Watchtower（方案 B）

### 1. 准备 GitHub 仓库

1. 新建仓库并推送本项目代码
2. 确保默认分支为 `main` 或 `master`
3. 推送后 GitHub Actions 会构建镜像并推到：

```text
ghcr.io/<你的GitHub用户名>/usdt-income-bot:latest
```

首次若 Packages 是 private，到 GitHub → Packages 里确认可见性；VPS 拉私有镜像需要 PAT。

### 2. VPS 首次部署

```bash
# 安装 Docker（若尚未安装）
curl -fsSL https://get.docker.com | sh

mkdir -p /opt/usdt-income-bot && cd /opt/usdt-income-bot
```

创建 `.env`：

```bash
TELEGRAM_BOT_TOKEN=你的BotToken
# TRONGRID_API_KEY=可选默认Key
DEFAULT_USDT_CNY_RATE=7.20
```

创建 `docker-compose.yml`（从仓库复制，并改镜像名）：

```yaml
# image: ghcr.io/你的用户名/usdt-income-bot:latest
```

或导出环境变量：

```bash
export GITHUB_OWNER=你的用户名
```

#### 私有 ghcr 镜像登录（Watchtower 需要）

1. GitHub → Settings → Developer settings → Personal access tokens  
   创建 PAT，权限至少包含 `read:packages`
2. 在 VPS 登录一次（凭据写入 `~/.docker/config.json`，Watchtower 会挂载它）：

```bash
echo PAT | docker login ghcr.io -u GITHUB用户名 --password-stdin
```

3. 修改 `docker-compose.yml` 中的镜像名，或在 `.env` 增加：

```bash
BOT_IMAGE=ghcr.io/你的用户名/usdt-income-bot:latest
```

4. 启动：

```bash
docker compose pull
docker compose up -d
docker compose logs -f bot
```

> 若镜像设为 public，也可不 login；私有包必须 login。  
> 备用：也可按 `watchtower-config.example.json` 自建 auth 文件，并把 compose 里的挂载改成该文件。

### 3. 之后如何更新

```text
本机改代码 → git push → Actions 构建新镜像
         → Watchtower 约 5 分钟内自动 pull 并重启 bot
```

数据在 `./data` 卷中，**更新镜像不会丢用户地址/配置**。

### 4. 常用运维

```bash
cd /opt/usdt-income-bot
docker compose logs -f bot
docker compose restart bot
docker compose pull && docker compose up -d
```

备份：

```bash
tar czf usdt-bot-data-$(date +%F).tgz data .env
```

回滚到某次提交镜像：

```bash
# Actions 会推 sha-xxxxxxx 标签
docker compose stop bot
docker run --rm -v "$PWD/data:/app/data" --env-file .env \
  ghcr.io/你的用户名/usdt-income-bot:sha-xxxxxxx
# 或临时改 compose 的 image tag 后 up -d
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 是 | BotFather 发放的 Token |
| `TRONGRID_API_KEY` | 否 | 服务器默认 Key |
| `DATA_DIR` | 否 | 默认 `./data`（容器内 `/app/data`） |
| `DEFAULT_USDT_CNY_RATE` | 否 | 默认 `7.20` |
| `ADDRESS_CONCURRENCY` | 否 | 默认 `3` |
| `REQUEST_TIMEOUT_MS` | 否 | 默认 `15000` |
| `MAX_REQUEST_RETRIES` | 否 | 默认 `2` |

## 目录结构

```text
├── src/
│   ├── index.js      # 入口
│   ├── bot.js        # Telegram 命令
│   ├── trongrid.js   # 查询与汇总（自网页逻辑迁移）
│   ├── storage.js    # 用户数据 JSON 存储
│   └── config.js
├── Dockerfile
├── docker-compose.yml
├── .github/workflows/docker-publish.yml
├── .env.example
└── usdt-收入分析.html   # 原网页版（保留）
```

## 安全建议

- 仅私聊使用 `/setkey`，不要在群里发 Key
- `.env`、`data/`、`watchtower-config.json` 不要提交 Git
- 生产环境建议 ghcr 私有包 + PAT 只读权限
- 定期备份 `data/users.json`

## 许可

按你自己的项目需要自行声明。
