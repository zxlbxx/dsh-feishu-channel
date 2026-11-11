// dsh-feishu-channel — DSH ⇄ 飞书/Lark 通道插件。
//
// 做三件事：
//   1. 会话跑完 / 出错时，把结果推到飞书（可配置开关与最小间隔）；
//   2. 读飞书群里人发的消息，投递给对应工作区的会话（手机下任务）；
//   3. /feishu 命令：doctor 自检、test 发测试消息、bind 绑定群、spawn 新建会话。
//
// 所有凭据只从本机配置读取，不写进仓库、不发给第三方：
//   ~/.dsh/feishu/app.json      { "app_id": "...", "app_secret": "...", "chat_id": "..." }
//   ~/.dsh/feishu/plugin.json   { "enabled": true, "minIntervalSec": 60, ... }
//
// 依赖桌面版 profile 提供的 agents / workspaceRegistry / sessionController 服务。
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'feishu';
export const inject = ['agents', 'workspaceRegistry', 'sessionController'];

const API = 'https://open.feishu.cn/open-apis';
const STATE_DIR = join(homedir(), '.dsh', 'feishu');

const configPath = () => process.env.DSH_FEISHU_CONFIG || join(STATE_DIR, 'app.json');

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 1));
}

async function readConfig() {
  const cfg = await readJson(configPath(), null);
  if (!cfg) throw new Error(`找不到配置：${configPath()}（需要 app.json）`);
  for (const key of ['app_id', 'app_secret', 'chat_id']) {
    if (!cfg[key]) throw new Error(`配置缺少 ${key}`);
  }
  return cfg;
}

async function post(path, body, token) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path, token) {
  const res = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  return res.json();
}

async function token(cfg) {
  const r = await post('/auth/v3/tenant_access_token/internal', {
    app_id: cfg.app_id, app_secret: cfg.app_secret,
  });
  if (r.code !== 0) throw new Error(`取 token 失败: ${r.code} ${r.msg}`);
  return r.tenant_access_token;
}

async function send(cfg, tok, text, title, chatId) {
  const body = title ? `${title}\n${text}` : text;
  const r = await post('/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId || cfg.chat_id, msg_type: 'text',
    content: JSON.stringify({ text: body }),
  }, tok);
  if (r.code !== 0) throw new Error(`发送失败: ${r.code} ${r.msg}`);
  return r.data?.message_id ?? '';
}

// ------------------------------------------------------------ 配置与路由
const PLUGIN_CONF = join(STATE_DIR, 'plugin.json');
const NOTIFY_CONF = join(homedir(), '.dsh', 'notify', 'config.json');

async function pluginConf() {
  const raw = await readJson(PLUGIN_CONF, {});
  return { enabled: false, minIntervalSec: 60, events: ['done', 'error'], ...raw };
}

async function taskConf() {
  const plugin = await readJson(PLUGIN_CONF, {});
  const notify = await readJson(NOTIFY_CONF, {});
  return {
    enabled: plugin.taskEnabled !== false,
    pollSeconds: plugin.taskPollSeconds ?? 15,
    chats: notify?.task?.chats ?? {},
    bound: plugin.tasks ?? {},
  };
}

/** 按工作区前缀路由到不同的飞书群；没命中就用默认群。 */
async function routeFor(cwd) {
  const conf = await readJson(NOTIFY_CONF, {});
  const ws = String(cwd || '');
  for (const rule of conf.routing ?? []) {
    const root = String(rule.match ?? '');
    if (root && (ws === root || ws.startsWith(root + '/'))) {
      return { chatId: rule.chat_id, name: rule.name ?? root.split('/').pop() };
    }
  }
  return { chatId: conf?.feishu?.chat_id, name: 'default' };
}

// ------------------------------------------------------------ 会话工具
/** 把新会话登记进 workspace.json，App 的会话列表才认它。 */
async function indexSession(workspacePath, sessionId) {
  const store = join(homedir(), '.dsh', 'storages', 'workspace.json');
  try {
    const data = JSON.parse(await readFile(store, 'utf8'));
    const tables = data.tables?.workspaces ?? {};
    const entry = Object.values(tables).find(w => w?.path === workspacePath);
    if (!entry) return false;
    entry.sessionIds = entry.sessionIds ?? [];
    if (!entry.sessionIds.includes(sessionId)) entry.sessionIds.unshift(sessionId);
    entry.updatedAt = new Date().toISOString();
    const tmp = store + '.tmp';
    await writeFile(tmp, JSON.stringify(data));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, store);
    return true;
  } catch {
    return false;
  }
}

/** 找出某工作区里最近更新的会话（按 session 日志的 mtime）。 */
async function latestSession(workspacePath) {
  const { readdir, stat } = await import('node:fs/promises');
  const dirName = '--' + String(workspacePath).replace(/^\/+|\/+$/g, '').replace(/\//g, '-') + '--';
  const base = join(homedir(), '.dsh', 'sessions', dirName);
  let entries = [];
  try { entries = await readdir(base); } catch { return null; }
  let best = null;
  for (const entry of entries) {
    if (!entry.startsWith('session-')) continue;
    try {
      const st = await stat(join(base, entry, 'session.v4.jsonl.zstd'));
      if (!best || st.mtimeMs > best.mtime) best = { session: entry, mtime: st.mtimeMs };
    } catch {}
  }
  return best;
}

async function feishuMessages(chatId, sinceMs) {
  const app = await readConfig();
  const tok = await token(app);
  const r = await get(`/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&sort_type=ByCreateTimeDesc&page_size=20`, tok);
  if (r.code !== 0) throw new Error(`读取失败: ${r.code} ${r.msg}`);
  return (r.data?.items ?? []).map(m => {
    let text = m.body?.content ?? '';
    try { text = JSON.parse(text).text ?? text; } catch {}
    return { id: m.message_id, at: Number(m.create_time || 0), text,
             human: (m.sender?.sender_type === 'user') && String(text).trim() !== '' };
  }).filter(m => m.human && m.at > Number(sinceMs || 0)).reverse();
}

async function feishuSend(chatId, text, title) {
  const app = await readConfig();
  const tok = await token(app);
  await send(app, tok, text, title, chatId);
}

function extractText(message) {
  const parts = message?.content ?? [];
  return parts.filter(p => p?.type === 'text' && p.text).map(p => p.text).join('\n').trim();
}

export function apply(ctx) {
  const log = ctx.logger('feishu');

  const pending = new Map(); // sessionId -> 排队中的消息数
  const texts = new Map();   // sessionId -> 最后一条助手文本
  const sentAt = new Map();  // sessionId -> 上次发送时间
  let currentSessionId = '';
  let currentCwd = '';

  const lastText = (sid) => texts.get(sid) ?? '';
  const logline = (file, text) => appendFile(join(STATE_DIR, file),
    `${new Date().toISOString()} ${text}\n`).catch(() => {});

  // ---- 启动自检 ----
  ctx.effect(() => {
    readConfig()
      .then(async cfg => ({ cfg, tok: await token(cfg) }))
      .then(({ cfg, tok }) => log.info(`feishu ready: token ${String(tok).slice(0, 6)}…, chat ${cfg.chat_id}`))
      .catch(err => log.warn(`feishu 配置不可用：${err.message}（/feishu doctor 可排查）`));
  }, 'feishu startup check');

  // ---- /feishu 命令 ----
  ctx.inject(['commands'], (child) => {
    child.effect(() => child.commands.register({
      name: 'feishu',
      description: '飞书通道：doctor 自检 / test 发测试消息 / bind 绑定群 / spawn 新建会话',
      input: { hint: 'doctor | test [文字] | bind <chat_id> | spawn [目录] [任务]' },
      handler: async ({ rawInput, agent }) => {
        currentSessionId = agent?.session?.id ?? agent?.id ?? '';
        currentCwd = agent?.session?.header?.cwd ?? '';
        const arg = String(rawInput ?? '').trim();
        try {
          const cfg = await readConfig();
          const tok = await token(cfg);

          if (arg.startsWith('bind')) {
            const chat = arg.slice(4).trim();
            if (!chat) return { kind: 'error', text: '用法：/feishu bind <chat_id>' };
            return await bindSession(chat);
          }

          if (arg.startsWith('spawn')) {
            const rest = arg.slice(5).trim();
            const [maybePath, ...words] = rest.split(/\s+/);
            const cwd = rest && maybePath.startsWith('/') ? maybePath : (currentCwd || '/tmp');
            const text = (rest && maybePath.startsWith('/') ? words.join(' ') : rest) || '探针：只回复 OK';
            const detail = await spawnTask(cwd, text, agent);
            await logline('command.log', `spawn ${cwd} -> ${detail.replace(/\n/g, ' | ')}`);
            return { kind: 'success', text: `spawn 结果：\n${detail}` };
          }

          if (arg.startsWith('test')) {
            const text = arg.slice(4).trim() || '这是一条来自 dsh-feishu-channel 的测试消息。';
            const id = await send(cfg, tok, text, '🔔 dsh-feishu-channel');
            await logline('command.log', `test ok message_id=${id}`);
            return { kind: 'success', text: `已发送（message_id=${id}）` };
          }

          // doctor：默认分支
          const chats = await get('/im/v1/chats?page_size=20', tok);
          const list = (chats.data?.items ?? []).map(c => `${c.chat_id}  ${c.name ?? ''}`).join('\n') || '(机器人不在任何群里)';
          const plugin = await pluginConf();
          return {
            kind: 'success',
            text: [
              `app_id: ${cfg.app_id}`,
              `默认群: ${cfg.chat_id}`,
              `通知: ${plugin.enabled ? '开' : '关'}（事件 ${plugin.events?.join('/')}，最小间隔 ${plugin.minIntervalSec}s）`,
              `群列表:\n${list}`,
            ].join('\n'),
          };
        } catch (err) {
          await logline('command.log', `error ${err.message}`);
          return { kind: 'error', text: `feishu 失败：${err.message}` };
        }
      },
    }), 'feishu command');
  });

  /** 把当前会话绑定到某个飞书群，之后该群的消息都会投递进这个会话。 */
  async function bindSession(chat) {
    const plugin = await readJson(PLUGIN_CONF, {});
    const notify = await readJson(NOTIFY_CONF, {});
    const known = (notify?.task?.chats ?? {})[chat];
    plugin.tasks = plugin.tasks ?? {};
    plugin.tasks[chat] = { session: currentSessionId, cwd: currentCwd, workspace: known ?? currentCwd };
    await writeJson(PLUGIN_CONF, plugin);
    return {
      kind: 'success',
      text: `已绑定\n群：${chat}\n会话：${currentSessionId}\n工作区：${known ?? currentCwd}`,
    };
  }

  // ---- 会话事件：turn 结束 / 出错时推一条 ----
  ctx.on('session/event', (session, event) => {
    try {
      const sid = session?.id ?? session?.header?.id ?? 'unknown';
      if (event?.type === 'assistant/message') {
        const t = extractText(event.data?.message);
        if (t) texts.set(sid, t);
        return;
      }
      if (event?.type !== 'turn/end') return;
      pending.set(sid, Math.max(0, (pending.get(sid) ?? 1) - 1));
      const reason = event.data?.reason?.kind ?? 'completed';
      const cwd = session?.header?.cwd ?? '';
      pluginConf().then(async cfg => {
        if (!cfg.enabled) return;
        const kind = reason === 'completed' ? 'done' : 'error';
        if (!cfg.events.includes(kind)) return;
        const now = Date.now();
        if (now - (sentAt.get(sid) ?? 0) < cfg.minIntervalSec * 1000) return;
        sentAt.set(sid, now);
        try {
          const app = await readConfig();
          const tok = await token(app);
          const plugin = await readJson(PLUGIN_CONF, {});
          const boundChat = Object.entries(plugin.tasks ?? {}).find(([, v]) => v.session === sid)?.[0];
          if (boundChat) {
            await feishuSend(boundChat, lastText(sid).slice(0, 1500) || '(无文本输出)',
              kind === 'done' ? '✅ 完成' : '❌ 出错');
            return;
          }
          const route = await routeFor(cwd);
          const project = route.name || String(cwd).split('/').filter(Boolean).pop() || 'dsh';
          const title = kind === 'done' ? `✅ 完成 · ${project}` : `❌ 出错 · ${project}`;
          const body = [lastText(sid).slice(0, 600) || '(无文本输出)', cwd ? `目录：${cwd}` : '']
            .filter(Boolean).join('\n\n');
          await send(app, tok, body, title, route.chatId);
          log.info(`turn/end -> feishu (${kind}, ${project})`);
          await logline('notify.log', `${kind} ${project} ${sid}`);
        } catch (e) {
          log.warn(`推送失败：${e.message}`);
        }
      }).catch(() => {});
    } catch (e) {
      log.warn(`事件处理失败：${e.message}`);
    }
  }, { global: true });

  // ---- 手机 → 会话：轮询群消息 ----
  async function pollTasks() {
    const conf = await taskConf();
    if (!conf.enabled || Object.keys(conf.chats).length === 0) return;
    const state = await readJson(join(STATE_DIR, 'task-state.json'), { cursors: {} });
    state.cursors = state.cursors ?? {};
    for (const chat of Object.keys(conf.chats)) {
      const bound = conf.bound[chat];
      const since = state.cursors[chat] ?? (Date.now() - 5 * 60 * 1000);
      let msgs = [];
      try { msgs = await feishuMessages(chat, since); } catch (e) { log.warn(`轮询 ${chat} 失败：${e.message}`); continue; }
      if (msgs.length) state.cursors[chat] = Math.max(...msgs.map(m => m.at));
      for (const m of msgs) {
        let target = bound?.session;
        let how = '已绑定';
        if (!target) {
          const latest = await latestSession(conf.chats[chat]);
          if (latest) { target = latest.session; how = '最近会话'; }
        }
        if (!target) {
          await feishuSend(chat, `这个群对应的工作区还没有任何会话：${conf.chats[chat]}`, '⚠️ 无法投递').catch(() => {});
          continue;
        }
        try {
          const resolved = await ctx.sessionController.resolveAgent(target);
          if (!resolved || resolved.error) {
            await feishuSend(chat, `目标会话不可用：${JSON.stringify(resolved?.error ?? {})}`, '⚠️ 投递失败').catch(() => {});
            continue;
          }
          const depth = (pending.get(target) ?? 0) + 1;
          pending.set(target, depth);
          resolved.agent.followup({
            id: 'feishu:' + m.id, role: 'user',
            content: [{ type: 'text', text: m.text }],
            source: { kind: 'dsh-feishu-channel' },
          });
          const queueNote = depth > 1 ? `\n排队第 ${depth} 位（前一条还在跑）` : '';
          await feishuSend(chat, `收到，已交给${how}：${target}${queueNote}`, '⏳ 已接单').catch(() => {});
          log.info(`task ${m.id} -> ${target} (${how})`);
        } catch (e) {
          log.warn(`投递失败：${e.message}`);
          await feishuSend(chat, `投递失败：${e.message}`, '⚠️ 任务失败').catch(() => {});
        }
      }
    }
    await writeJson(join(STATE_DIR, 'task-state.json'), state);
  }

  /** 取当前会话的 provider/model（拿不到就退到 modelCatalog 的第一项）。 */
  async function pickModel(invokingAgent) {
    try {
      const cfg = invokingAgent?.session?.requestHeader?.()?.config;
      if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model };
    } catch {}
    try {
      const cat = await ctx.sessionController.modelCatalog();
      const g = (cat?.groups ?? []).find(x => (x.models ?? []).length);
      const m = g?.models?.[0];
      if (g && m) return { provider: g.id, model: m.id };
    } catch {}
    return null;
  }

  /** 新建会话 + 选模型 + 投递首条消息 + 登记索引。 */
  async function spawnTask(cwd, text, invokingAgent) {
    const out = [];
    try {
      const { randomUUID } = await import('node:crypto');
      const list = await ctx.workspaceRegistry.list();
      let workspace = (list ?? []).find(w => w?.path === cwd);
      out.push(`workspace ${workspace ? workspace.id : 'miss'}`);
      workspace ??= await ctx.workspaceRegistry.create(cwd);
      const sessionId = 'session-' + randomUUID();
      const created = await ctx.sessionController.create({
        sessionId, workspaceId: workspace.id,
        agentPreset: process.env.DSH_FEISHU_PRESET || 'standard',
      });
      out.push(`create ${JSON.stringify(created)}`);
      const model = await pickModel(invokingAgent);
      if (model) {
        try {
          await ctx.sessionController.selectModel({ sessionId, provider: model.provider, model: model.model });
          out.push(`model ${model.provider}/${model.model}`);
        } catch (e) {
          out.push(`selectModel fail ${e?.message}`);
        }
      }
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if (!resolved || resolved.error) {
        out.push(`resolve error ${JSON.stringify(resolved?.error)}`);
      } else {
        resolved.agent.followup({
          id: 'feishu:' + randomUUID(), role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-feishu-channel' },
        });
        out.push('followup ok');
      }
      out.push(`indexed ${await indexSession(cwd, sessionId)}`);
    } catch (e) {
      out.push(`ERROR ${e?.name}: ${e?.message}`);
    }
    return out.join('\n');
  }

  // ---- 轮询定时器 ----
  ctx.effect(() => {
    const timer = setInterval(() => {
      pollTasks().catch(e => log.warn(`任务轮询失败：${e.message}`));
    }, 15000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'feishu task polling');

  log.info('feishu plugin loaded');
}
