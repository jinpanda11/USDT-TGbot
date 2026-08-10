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

## 测试

```bash
npm run check   # 语法检查
npm test        # 单元测试（node:test，无额外依赖）
```

CI（GitHub Actions）在构建 Docker 镜像前会自动执行 `npm ci` + 语法检查 + 单元测试，任一失败则不会发布。

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
| `ADDRESS_CONCURRENCY` | 否 | 默认 `3`（1-20） |
| `REQUEST_TIMEOUT_MS` | 否 | 默认 `15000`（1000-120000） |
| `MAX_REQUEST_RETRIES` | 否 | 默认 `2`（0-5） |
| `ALLOWED_TELEGRAM_USER_IDS` | 否 | 允许使用的用户 ID 逗号列表；留空 = 不限制 |
| `REQUIRE_PRIVATE_CHAT` | 否 | 默认 `true`：敏感操作仅限私聊 |
| `GLOBAL_QUERY_CONCURRENCY` | 否 | 全局同时查询数，默认 `2` |
| `MAX_QUERIES_PER_USER_PER_MIN` | 否 | 每用户每分钟查询上限，默认 `5`（0=不限制） |
| `QUERY_CACHE_TTL_MS` | 否 | 相同查询结果缓存，默认 `60000`（0=关闭） |
| `MAX_PAGES_PER_ADDRESS` | 否 | 单地址最大翻页数，默认 `100` |
| `MAX_RECORDS_PER_QUERY` | 否 | 单次查询最大记录数，默认 `100000` |
| `QUERY_TOTAL_TIMEOUT_MS` | 否 | 单次查询总超时，默认 `300000` |
| `SESSION_TTL_MS` | 否 | 会话有效期，默认 `1800000`（30 分钟） |
| `LOG_LEVEL` | 否 | 日志级别 `debug/info/warn/error`，默认 `info`（JSON 输出） |
| `HEALTH_PORT` | 否 | 健康检查端口，默认 `0`（关闭） |

非法配置值（越界/非数字）会在启动时直接报错（fail fast），错误信息包含变量名和实际值。

## 目录结构

```text
├── src/
│   ├── index.js      # 入口（健康检查、优雅退出）
│   ├── bot.js        # Telegram 命令与访问控制
│   ├── trongrid.js   # 查询与汇总（地址校验、去重、限流边界）
│   ├── storage.js    # 用户数据 JSON 存储（损坏保护、schema 校验）
│   ├── config.js     # 配置解析与范围校验
│   ├── logger.js     # 结构化 JSON 日志（含脱敏）
│   └── query-gate.js # 全局并发/限流/查询缓存
├── scripts/check-syntax.js
├── test/             # node:test 单元测试
├── Dockerfile
├── docker-compose.yml
├── .github/workflows/docker-publish.yml
├── .env.example
└── usdt-收入分析.html   # 原网页版（保留）
```

## 安全建议

- **访问控制**：设置 `ALLOWED_TELEGRAM_USER_IDS` 只允许你自己的账号使用；保持 `REQUIRE_PRIVATE_CHAT=true`，避免群聊中暴露地址、Key 和收入信息。
- 仅私聊使用 `/setkey`，不要在群里发 Key；日志和报错均不会输出完整 API Key。
- TRON 地址会做 Base58Check 校验（服务端与 Bot 双重校验），无效地址无法添加。
- `.env`、`data/`、`watchtower-config.json` 不要提交 Git
- 生产环境建议 ghcr 私有包 + PAT 只读权限
- 定期备份 `data/users.json`；`users.json` 损坏时会自动生成 `.corrupt-<时间戳>.bak` 备份并拒绝以空数据覆盖，恢复后重启即可。
- 恶意/损坏的用户数据条目会在启动时被归一化丢弃并记日志，不会导致整个文件失效。

## 许可

按你自己的项目需要自行声明。
