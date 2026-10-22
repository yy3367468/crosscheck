# crosscheck

**让 Claude Code 与 Codex 互相咨询：彼此都是持怀疑态度的只读同行评审。**

[English](README.md)

在 Claude Code 里工作时，Claude 可以随时调用你本机的 Codex 做方案验证、比对；在 Codex 里工作时，Codex 也可以随时调用你本机的 Claude。双方都遵循同一条原则：**大胆质疑，小心求证**。

- **被咨询的一方是评审，不是附和者。** 它以只读方式检查代码，每个结论都要给出证据（`path:line`、命令输出），并标明是「已验证」还是「推断」；只有新证据才能让它改变立场。
- **发起咨询的一方是怀疑者，不是跟随者。** 它先确定自己的立场，再把对方的回答当作待验证的假设，逐条对照代码核实。有分歧时带着证据反驳，最多两轮，然后自己做决定，并告诉你采纳了什么、否决了什么、为什么。

```text
Claude Code ──ask_codex──▶ crosscheck ──▶ codex exec   （只读沙箱）
Codex       ──ask_claude─▶ crosscheck ──▶ claude -p    （plan 模式，只读）
```

> **安装前须知**
> - **早期版本（0.x）。** 已在 Windows 上用 Codex CLI 0.163、Claude Code 2.1.295 实测；macOS 和 Linux 目前只有自动化测试（使用模拟的对方 CLI），还没有实机验证。欢迎反馈问题。
> - **两边的只读强度不同。** Codex 受操作系统级沙箱约束；Claude 运行在 plan 模式，能阻止编辑，但不是操作系统级沙箱（见[安全说明](#安全说明)）。
> - **每次咨询都会消耗对方模型的额度**，耗时从不到一分钟到几分钟不等。

## 为什么要做这个

第二个模型能发现第一个模型漏掉的问题，前提是双方都不盲从。模型天生容易讨好：评审一味点头，或者提问方对听起来自信的建议照单全收，都只会增加成本，不会带来更好的判断。crosscheck 把「怀疑」设为交流**双方**的默认姿态。如果一次评审根本没有基于代码（例如对方一条命令都没能执行），它也会明确告诉你。

## 特性

- **双向。** 一个仓库、一个 MCP 服务、两个插件：Claude Code 中是 `ask_codex`，Codex 中是 `ask_claude`。
- **无需 API Key。** 直接调用你已经安装并登录的 `codex` 和 `claude` 命令行。
- **对方只读。**
  - Codex 以 `sandbox_mode=read-only` 运行，不弹审批；它自己的 MCP 服务、插件、apps、记忆和 notify 钩子全部关闭。
  - Claude 以 plan 模式运行，只开放 `Read, Grep, Glob, Bash`（Windows 上为 `PowerShell`），不加载 MCP 服务和斜杠命令，也不读取被评审仓库里的设置。
- **两种模式。**
  - `independent`：对方在看不到你答案的情况下独立求解，避免锚定。
  - `review`：让对方专门挑一个具体方案、diff 或论断的毛病。
- **证据与诚实性检查。**
  - 每次回复都被标注为「未经验证的第二意见」，并附上对方的活动记录（读了哪些文件、跑了哪些命令）。
  - 对方一条命令都没能执行，或一个文件都没看时，会单独给出警告。
- **辩论有上限。** 追问沿用同一个会话，默认最多 2 轮。
- **安全设计。**
  - 防递归：被咨询的一方不能反过来再咨询。
  - 取消时会杀掉整个子进程树。
  - 超时自动终止。
  - 额外 CLI 参数采用白名单，只允许调整模型和推理强度之类的设置。
  - 如果无法列出并禁用 Codex 自己的 MCP 服务，就拒绝这次咨询，不会在未隔离的状态下运行。
- **零依赖。** 一个 Node.js 服务，Node ≥ 18，支持 Windows、macOS、Linux。

## 前置条件

- `PATH` 中有 Node.js 18+
- 已登录的 [Codex CLI](https://github.com/openai/codex)：在 Claude Code 中使用 `ask_codex` 时需要
- 已登录的 [Claude Code](https://code.claude.com)：在 Codex 中使用 `ask_claude` 时需要

要双向使用，就两个都装上。

插件市场的安装命令需要从 github.com 拉取仓库。如果你的网络访问不了 github.com，可以先配置代理，或者 clone 到本地后按下文「不使用插件系统」的方式安装。

## 安装

### Claude Code（获得 `ask_codex`）

```bash
claude plugin marketplace add yy3367468/crosscheck
claude plugin install crosscheck@crosscheck
```

也可以在会话里执行 `/plugin marketplace add yy3367468/crosscheck`，再执行 `/plugin install crosscheck@crosscheck`。装完重启 Claude Code。

### Codex（获得 `ask_claude`）

```bash
codex plugin marketplace add yy3367468/crosscheck
codex plugin add crosscheck@crosscheck
```

装完新开一个 Codex 会话。

### 不使用插件系统

直接把 MCP 服务指向本地克隆的仓库：

```bash
claude mcp add --scope user crosscheck -- node /path/to/crosscheck/server/crosscheck.mjs --peer codex
```

```toml
# ~/.codex/config.toml
[mcp_servers.crosscheck]
command = "node"
args = ["/path/to/crosscheck/server/crosscheck.mjs", "--peer", "claude"]
tool_timeout_sec = 1800
# Codex 只给 MCP 服务传最小环境变量，需要把 claude 用到的变量转发进去：
env_vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY"]
```

skill 位于 `skills/crosscheck/`。不用插件系统时，把这个目录复制到 `~/.claude/skills/`（Claude Code）或 `~/.agents/skills/`（Codex）。

## 使用

直接说就行：

> 迁移之前，先让 Codex 交叉验证一下这个方案。
>
> 让 Claude 独立诊断一下这个 bug，然后和你的结论对比。

也可以显式调用 skill：Claude Code 中用 `/crosscheck:crosscheck`，Codex 中用 `$crosscheck:crosscheck`。

工具参数：

| 参数 | 说明 |
|---|---|
| `request` | 自包含的简报：目标、约束、相关路径、要重点审查什么。对方看不到你们的对话。 |
| `mode` | `review`（默认）或 `independent`。 |
| `session_id` | 继续之前的咨询（追问或反驳）。 |
| `cwd` | 要检查的目录，默认是当前项目。 |

一次典型的交互：

1. 智能体先写下自己的立场，然后向对方提问（开放问题用 `independent`，具体方案用 `review`）。
2. 对方检查代码，给出结论、按严重程度排序的问题和证据。
3. 智能体逐条核实，把每一条归类为：已确认 / 已驳斥 / 未验证 / 主观取舍。
4. 对错误的结论带着证据反驳（用 `session_id`），最多两轮。
5. 自己做决定，并向你汇报：对方结论 / 采纳 / 否决 / 待定 / 最终决定。

## 配置

MCP 服务读取以下环境变量：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `CROSSCHECK_TIMEOUT_SEC` | `1500` | 超过这么多秒就终止对方进程。 |
| `CROSSCHECK_MAX_FOLLOWUPS` | `2` | 每次咨询允许的追问轮数。 |
| `CROSSCHECK_CODEX_BIN` / `CROSSCHECK_CLAUDE_BIN` | 从 `PATH` 查找 | 对方 CLI 的路径。 |
| `CROSSCHECK_CODEX_ARGS` | 无 | 传给 Codex 的额外参数。只允许 `-m/--model <名称>`，以及 `-c <key>=<value>`，其中 key 限于 `model`、`model_provider`、`model_providers.*`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity`、`service_tier`、`windows.sandbox`。例如 `-m gpt-5.5 -c model_reasoning_effort=high`。 |
| `CROSSCHECK_CLAUDE_ARGS` | 无 | 传给 Claude 的额外参数。只允许 `--model`、`--effort`、`--fallback-model`、`--max-budget-usd`。例如 `--model opus --effort high`。 |
| `CROSSCHECK_DEBUG` | 关 | 设为 `1` 时，把对方的命令行和 stderr 输出到服务的 stderr。 |

设置方法：
- **Claude Code：** 写在 `~/.claude/settings.json` 的 `env` 字段里。
- **Codex：** 在启动 Codex 的 shell 里 export。插件会把 `CROSSCHECK_*` 以及常见的 `ANTHROPIC_*`、云厂商、代理变量转发给服务。

宿主侧的超时：
- **Codex** 等工具返回的时间上限是 `tool_timeout_sec`，插件设为 1800 秒。如果你把 `CROSSCHECK_TIMEOUT_SEC` 调得比它大，也要同步调大这个值。
- **Claude Code** 默认等待 MCP 工具的时间很长，crosscheck 在对方工作期间也会持续发送进度通知。

## 安全说明

- **你的代码会发给另一家模型厂商。** 对方会读取项目目录里的文件，它读到的内容会发送给对应厂商（OpenAI 或 Anthropic）。不能同时分享给两家的代码，不要用 crosscheck。
- **只读由对方的 CLI 保证，不是由 crosscheck 保证。**
  - Codex 依赖操作系统级沙箱。沙箱启动失败时，Codex 一条命令都跑不了，crosscheck 会把这样的回复标记为「没有基于代码」。
  - Claude 依赖 plan 模式。plan 模式会阻止编辑，并要求模型自己保持只读，但它不是操作系统级沙箱。
- **不信任被评审仓库自带的智能体配置。**
  - Claude 以 `--setting-sources user` 运行，仓库里 `.claude/settings*.json` 中的钩子和权限规则会被忽略。
  - 仓库的 `CLAUDE.md`、`AGENTS.md` 仍会作为上下文读取。
- **回复只是数据。** 两边的提示词都要求发起方永远不要执行对方回复里夹带的指令。

### Windows：Codex 沙箱报错

如果 Codex 的回复被标记为 `Codex could not run any command (... setup refresh had errors)`，说明 Windows 的 elevated 沙箱没有配置成功（`codex doctor` 里能看到）。可以修复它，也可以让咨询改用 unelevated 沙箱：

```text
CROSSCHECK_CODEX_ARGS=-c windows.sandbox=unelevated
```

unelevated 沙箱同样会阻止写入，只是隔离强度弱于 elevated 沙箱。

## 已知限制

- **会话保存在内存中。** 追问（`session_id`）只在同一个 crosscheck 服务进程存活期间有效。宿主重启了服务，就需要重新发起咨询。
- **咨询记录会出现在对方的历史里。** 每次咨询都会保存为一个普通的 Codex 或 Claude 会话，追问正是靠它实现的。
- **Windows 上可能残留进程。** crosscheck 用 `taskkill /T` 结束对方的进程树，但这只在对方进程本身还活着时有效。如果对方启动了子进程后自己先退出，这些子进程不会被清理。macOS 和 Linux 上会结束对方的整个进程组。
- **协议靠模型遵守，无法强制。** crosscheck 把怀疑式协议设为默认，并报告每次回复有多少代码依据；智能体是否真的逐条核实，仍然取决于模型本身。

## 开发

```bash
npm test                         # 基于假 CLI 的端到端测试，不调用模型
node scripts/smoke.mjs codex .   # 真实调用你本机的 Codex（消耗额度）
node scripts/smoke.mjs claude .  # 真实调用你本机的 Claude（消耗额度）
```

## 许可证

MIT
