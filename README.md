# dsh-turn-usage

> DeepSeek Harness 的 token 用量与费用显示插件 · a [dsh-plugin](https://github.com/topics/dsh-plugin) for the DeepSeek Harness web UI
>
> 📦 仓库：<https://github.com/HABIDSKOFT/dsh-turn-usage>

为 **DeepSeek Harness Web UI** 增加逐轮 token 消耗与估算价格显示：输入（缓存未命中/命中）、输出、以及单次任务的实时费用。

## 功能

- **每轮完成后的尾部行**（`conversation.chat.turnTail`）：
  显示如`输入 2.1K未命中 · 3.4K命中 · 输出 5.2K · 费用 ≈¥0.0035`的信息。
- **底部 StatsLine 增强**：以同 id（`stats`）完整保留原有内容（轮数 / 耗时 / 速率 / 缓存命中 / 输入输出），并在 **token 计数组内追加「最新任务累计费用 ≈¥X」** 。
- **中断（停止）的步骤**：若停止前收到了 usage chunk，其消耗会计入该轮行与最新任务费用（折叠读取视图节点 `data.usage`，与 harness 服务端投影同源）；若停止过早连 usage chunk 都没收到，则该步无数据可计（harness 自身投影同样不计）。
- **价格可配置**：内置 8/17 起峰谷后自动切换DeepSeek价格表；设置界面GUI编辑 JSON，可根据需求修改模型对应价格。

数据来自每个 assistant 节点自带的 provider usage（`inputTokens`=未命中、`cacheReadTokens`=命中、`cacheWriteTokens`=写缓存、`outputTokens`=输出）。

## 截图

**输入框底部单次任务消耗显示**  
<img width="1218" height="53" alt="image" src="https://github.com/user-attachments/assets/6ec897db-cf62-46aa-b2a4-e3b929a92d40" />

**对话末尾消耗显示**  
<img width="519" height="60" alt="image" src="https://github.com/user-attachments/assets/fd4ecc4e-0986-4456-bdb5-56e26f0091f9" />

## 安装

### 方式一：手动安装（推荐，无需 pnpm）

1. 获取插件文件夹 —— 克隆本仓库：
   ```sh
   git clone https://github.com/HABIDSKOFT/dsh-turn-usage.git
   ```
   或从仓库主页 Code → Download ZIP 解压，得到 `dsh-turn-usage/` 文件夹。
2. 把 `dsh-turn-usage` 文件夹复制到你的 web profile 依赖目录：
   ```powershell
   Copy-Item -Recurse dsh-turn-usage "$env:USERPROFILE\.dsh\profiles\node_modules\"
   ```
3. 在 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`）追加启用条目：
   ```yaml
   - insert:
       - id: turn-usage
         name: dsh-turn-usage
   ```
4. 重启 `dsh web`，浏览器硬刷新（`Ctrl+Shift+R`）。

### 方式二：`dsh plugin` 从本地路径安装（需要 pnpm）

```sh
# 写法 A：克隆后进入克隆出的文件夹，用 . 表示"当前目录本身"
git clone https://github.com/HABIDSKOFT/dsh-turn-usage.git
cd dsh-turn-usage
dsh plugin --profile web add .

# 写法 B：或在任意目录用克隆文件夹的完整路径
dsh plugin --profile web add C:\你的路径\dsh-turn-usage
```

然后同样在 `cordis.patch.yml` 加上面的启用条目并重启。

> 注意：本插件尚未发布到 npm，所以 `dsh plugin --profile web add dsh-turn-usage`（不带路径）会找不到包。想一行命令安装，可以先 `npm publish` 发布到 npm，之后直接 `dsh plugin --profile web add dsh-turn-usage` 即可。

### 卸载

1. 删除 `cordis.patch.yml` 里的 `turn-usage` 条目（或加 `disabled: true`）
2. （可选）删除 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-turn-usage\`
3. 重启 `dsh web`

## 价格配置

**推荐：界面化** —— 设置 → 通用 → 「Token 价格表（dsh-turn-usage）」：

- **「添加模型」按钮**：弹窗输入模型名 + 缓存命中/缓存未命中/缓存写入/输出四个价格（¥/Mtokens），保存后写入价格表
- **「修改模型」按钮**：下拉选择已有模型，修改四个价格后保存更新（保留峰谷结构，仅更新平铺价）
- 也可直接编辑 JSON 保存即生效，费用行实时重算。价格按每轮真实模型名自动匹配（无需手动指定），未配置的模型按 `*` 兜底价。

> 缓存写入（cacheWrite）：新 prompt 内容首次处理时写入缓存所计的费用。DeepSeek 不单独计费（未命中价已含，adapter 也不上报该桶）；Anthropic 等厂商按此参数单独计价。

默认价格（人民币 / 每百万 token，来源 [DeepSeek 官方定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)）：

**当前价（2026-08-17 前生效）**

| 模型 | 输入(未命中) | 缓存命中 | 输出 |
|---|---|---|---|
| deepseek-v4-flash | ¥1 | ¥0.02 | ¥2 |
| deepseek-v4-pro | ¥3 | ¥0.025 | ¥6 |
| deepseek-chat（旧） | ¥2 | ¥0.5 | ¥8 |
| deepseek-reasoner（旧） | ¥4 | ¥1 | ¥16 |

**2026-08-17 起峰谷定价**（插件自动切换，无需手动改）：高峰时段 = 北京时间 09:00-12:00、14:00-18:00；空闲时段 = 高峰的一半。

| 模型 | 时段 | 输入(未命中) | 缓存命中 | 输出 |
|---|---|---|---|---|
| deepseek-v4-flash | 空闲 | ¥1.5 | ¥0.05 | ¥4.5 |
| deepseek-v4-flash | 高峰 | ¥3.0 | ¥0.10 | ¥9.0 |
| deepseek-v4-pro | 空闲 | ¥4.5 | ¥0.15 | ¥13.5 |
| deepseek-v4-pro | 高峰 | ¥9.0 | ¥0.30 | ¥27.0 |

JSON 支持两种结构：

- 平铺：`{ "deepseek-v4-flash": { input, cacheRead, cacheWrite, output } }`
- 峰谷自动切换：`{ "deepseek-v4-flash": { input, cacheRead, cacheWrite, output, switchAt: "2026-08-17T00:00:00+08:00", peak: {...}, offPeak: {...} } }`（`switchAt` 之前用平铺价，之后按北京时间自动选 peak/offPeak）

运行时可覆盖（无需改文件，JSON 合并进默认表，保存后自动持久化到宿主配置文件）：

```js
localStorage["dsh.turnUsage.prices"] = JSON.stringify({
  "deepseek-v4-flash": { input: 1.0, cacheRead: 0.2, cacheWrite: 1.0, output: 4.0 }
});
```

> **对于自定义模型的提供方，特别是 API 平台，受到不公开的 token 测算影响，计算的费用会有所浮动；对于原生 DeepSeek 不受影响。**

## 配置持久化（跨重启）

桌面端每次启动都随机换端口（`dsh web --port 0`），浏览器 localStorage 按 origin 隔离，端口一变就全部丢失——价格配置因此会"重启后回溯默认"。插件用宿主 JSON 文件解决：

- 配置文件：`<DSH_HOME>/storages/dsh-turn-usage.json`（`DSH_HOME` 默认 `~/.dsh`，即 `%USERPROFILE%\.dsh`）
- 启动时 host 半部读取该文件，作为「dsh-turn-usage」settings 命名空间的 `base` 层注入，并通过 `GET /api/dsh-turn-usage/config`（loopback-only）供浏览器半部加载
- 每次保存配置，浏览器半部 `POST` 到同一路由（带每进程随机 token 防跨站写入），host 原子写盘（tmp + rename），并同步写入宿主 settings 文档（`~/.dsh/settings.yaml`）作第二份副本
- 旧版本（无该路由的 host）下插件自动降级为纯 localStorage，不报错

设置窗口高度默认较大（360px），手动拖动后自动记住高度（`localStorage["dsh.turnUsage.editorHeight"]`）。

## 工作原理

- host 半部（`lib/index.js`）：读取/写入上述 JSON 文件，注册 settings 命名空间，注册 `GET/POST /api/dsh-turn-usage/config` 精确路由（仅回环地址，POST 带 token 校验）
- 浏览器半部经 `exports["./client"]` + `dsh.client.platform: "web"` 被发现并注入 boot graph
- 注入点：
  - `conversation.chat.turnTail`（每轮尾部，priority -1 赢得选举并组合渲染产物卡片）
  - `conversation.composer.dock` id `stats`（priority -1 替换自带 StatsLine，token 组内追加最新任务费用）
  - `settings.general.item`（价格配置行）
- 价格读取优先级：每轮真实模型名精确匹配 → `deepseek-*` 家族前缀 → `*` 兜底（无需手动指定模型）

## 兼容性

- 开发/验证环境：`@deepseek-ai/dsh@0.1.0-rc.6`（web profile）
- 依赖 `@deepseek-ai/dsh-client-ui-deliverables`（产物组件，缺失时优雅降级只显示用量行）

## License

MIT © [HABIDSKOFT](https://github.com/HABIDSKOFT)
