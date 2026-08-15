# dsh-turn-usage

> DeepSeek Harness 的 token 用量与费用显示插件 · a [dsh-plugin](https://github.com/topics/dsh-plugin) for the DeepSeek Harness web UI

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

1. 把 `dsh-turn-usage` 文件夹复制到你的 web profile 依赖目录：
   ```powershell
   Copy-Item -Recurse dsh-turn-usage "$env:USERPROFILE\.dsh\profiles\node_modules\"
   ```
2. 在 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`）追加启用条目：
   ```yaml
   - insert:
       - id: turn-usage
         name: dsh-turn-usage
   ```
3. 重启 `dsh web`，浏览器硬刷新（`Ctrl+Shift+R`）。

### 方式二：`dsh plugin`（需要 pnpm）

```sh
dsh plugin --profile web add dsh-turn-usage
```

然后同样在 `cordis.patch.yml` 加上面的启用条目并重启。

### 卸载

1. 删除 `cordis.patch.yml` 里的 `turn-usage` 条目（或加 `disabled: true`）
2. （可选）删除 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-turn-usage\`
3. 重启 `dsh web`

## 价格配置

**推荐：界面化** —— 设置 → 通用 → 「Token 价格表（dsh-turn-usage）」：直接编辑 JSON 保存即生效，费用行实时重算；「当前模型」输入框用于定价匹配（客户端拿不到每步模型名，切换模型后请填写，如 `deepseek-v4-pro`，否则按 `*` 兜底价估算）。

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

运行时可覆盖（无需改文件，JSON 合并进默认表）：

```js
localStorage["dsh.turnUsage.prices"] = JSON.stringify({
  "deepseek-v4-flash": { input: 1.0, cacheRead: 0.2, cacheWrite: 1.0, output: 4.0 }
});
```

设置窗口高度默认较大（360px），手动拖动后自动记住高度（`localStorage["dsh.turnUsage.editorHeight"]`）。

## 工作原理

- 纯客户端插件：无 host 端逻辑，`lib/index.js` 为空 apply，浏览器半部经 `exports["./client"]` + `dsh.client.platform: "web"` 被发现并注入 boot graph
- 注入点：
  - `conversation.chat.turnTail`（每轮尾部，priority -1 赢得选举并组合渲染产物卡片）
  - `conversation.composer.dock` id `stats`（priority -1 替换自带 StatsLine，token 组内追加最新任务费用）
  - `settings.general.item`（价格配置行）
- 价格读取优先级：用户设置「当前模型」→ 节点模型（harness 未投影，通常无）→ `*` 兜底

## 兼容性

- 开发/验证环境：`@deepseek-ai/dsh@0.1.0-rc.6`（web profile）
- 依赖 `@deepseek-ai/dsh-client-ui-deliverables`（产物组件，缺失时优雅降级只显示用量行）

## License

MIT © [Habidskoft](https://github.com/Habidskoft)
