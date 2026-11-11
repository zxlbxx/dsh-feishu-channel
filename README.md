# dsh-feishu-channel

把 **飞书 / Lark** 接成 DeepSeek Harness 的手机通道：电脑上的会话跑完或出错，手机上收到一条消息；你在手机上回一句话，它回到那个工作区的会话里继续干活。

> 只依赖飞书开放平台的自建应用，不需要公网回调地址、不需要 serverless、不需要备案。凭据全部留在本机。

## 能力

| 方向 | 做什么 | 怎么触发 |
|---|---|---|
| 桌面 → 手机 | 会话 `turn/end`（完成 / 出错）推送标题 + 最后一段回答 + 工作区目录 | 自动，按 `plugin.json` 的开关与最小间隔节流 |
| 桌面 → 手机 | 按工作区前缀路由到不同群（项目 A 发 A 群，其余发默认群） | `~/.dsh/notify/config.json` 的 `routing` |
| 手机 → 桌面 | 轮询群消息（15s），投递到该群绑定的会话；没绑定时投到该工作区**最近更新的会话** | 群里直接发消息 |
| 手机 → 桌面 | `/feishu bind <chat_id>` 把当前会话绑到某个群 | DSH 里执行命令 |
| 手机 → 桌面 | `/feishu spawn [目录] [任务]` 新建一个受管会话并投递任务（实验性） | DSH 里执行命令 |
| 排障 | `/feishu doctor` 自检、`/feishu test` 发一条测试消息 | DSH 里执行命令 |

## 安装

插件以 npm 包发布，DSH 桌面版「插件」页可以直接装：

```bash
# 方式一：插件市场里搜索 dsh-feishu-channel
# 方式二：命令行
dsh plugin add dsh-feishu-channel
```

安装后在插件页确认 `dsh-feishu-channel` 处于启用状态，重启（或刷新）DSH 桌面端。

## 配置

### 1. 飞书自建应用

在 [飞书开放平台](https://open.feishu.cn/app) 建一个**企业自建应用**（个人版租户会报 `21001 Access denied due to platform policy`，必须用企业租户）：

1. 开启机器人能力；
2. 申请权限：`im:message`、`im:message:send_as_bot`、`im:message.group_msg`、`im:chat:readonly`；
3. 发布版本并在企业内可用；
4. 把机器人拉进一个群（`im/v1/chats` 只列群，不列单聊）。

### 2. 本机配置

`~/.dsh/feishu/app.json`（权限 600）：

```json
{
  "app_id": "cli_xxxxxxxxxxxxxxxx",
  "app_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "chat_id": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

`~/.dsh/feishu/plugin.json`：

```json
{
  "enabled": true,
  "minIntervalSec": 60,
  "events": ["done", "error"],
  "taskEnabled": true,
  "taskPollSeconds": 15,
  "tasks": {}
}
```

- `enabled`：是否推送会话结果，默认 `false`（避免和其他通知插件双发）；
- `events`：推哪些事件，`done` / `error`；
- `minIntervalSec`：同一会话两条推送的最小间隔；
- `taskEnabled`：是否轮询群消息并投递到会话；
- `tasks`：`/feishu bind` 写入的「群 → 会话」绑定表，一般不用手改。

### 3. 工作区路由（可选）

`~/.dsh/notify/config.json`：

```json
{
  "feishu": { "chat_id": "oc_默认群" },
  "routing": [
    { "match": "/Users/me/work/project-a", "chat_id": "oc_项目A群", "name": "project-a" }
  ],
  "task": {
    "chats": {
      "oc_项目A群": "/Users/me/work/project-a"
    }
  }
}
```

- `routing`：桌面 → 手机的按目录路由；
- `task.chats`：群 → 工作区，决定手机消息投到哪个工作区（用于「最近会话」兜底）。

## 工作方式

- 插件在桌面版 profile 里加载，注入 `agents` / `workspaceRegistry` / `sessionController` 三个服务；headless profile 没有这些服务，插件会停在 `pending`，属正常。
- 会话结果推送读的是会话事件流里的 `assistant/message` 与 `turn/end`，不额外调用模型。
- 手机消息通过 `agent.followup()` 投递，来源标记为 `dsh-feishu-channel`（DSH 会拒绝来源为 `plugin` 的消息）。
- 投递目标优先级：`/feishu bind` 的显式绑定 → 该工作区最近更新的会话。

## 隐私与安全

- 包内不含任何凭据、群 ID、会话 ID 或本机路径；所有配置在运行时从 `~/.dsh/feishu/app.json` 读取。
- 插件只与 `open.feishu.cn` 通信，不向其他地址发送数据。
- 飞书侧建议只把机器人拉进必要的群；`app_secret` 等同密码，泄露后到开放平台重置。

## 已知限制

- 只能投递到桌面端已经存在的会话；会话必须先在工作区里创建过（这是 DSH 的索引机制决定的）。
- `/feishu spawn` 依赖 DSH 内部 API（`sessionController.create/selectModel`），属于实验能力，不同版本可能失效。
- 群消息轮询是 15s 一次的长轮询，飞书侧有频率限制；消息量大时建议只保留必要群。
- 只支持文本消息；图片、文件、卡片消息会被忽略。

## License

MIT © lbxx
