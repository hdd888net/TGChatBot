let BOT_TOKEN;
let GROUP_ID;
let MAX_MESSAGES_PER_MINUTE = 40;
let verifiedTableReady = false;
let processedTableReady = false;
let replyMapTableReady = false;

const VERIFY_CODE = '888';
const VERIFY_TTL_SECONDS = 60 * 60; // 验证有效期：1 小时

const processedCallbacks = new Set();

const USER_MENU_BUTTONS = [
  [{ text: '📋 我的状态', callback_data: 'user_status' }],
  [{ text: '❓ 帮助说明', callback_data: 'user_help' }],
  [{ text: 'ℹ️ 关于机器人', callback_data: 'user_about' }]
];

export default {
  async fetch(request, env) {

    BOT_TOKEN = env.BOT_TOKEN_ENV;
    GROUP_ID = env.GROUP_ID_ENV;
    MAX_MESSAGES_PER_MINUTE = parseInt(env.MAX_MESSAGES_PER_MINUTE_ENV || '40');

    if (!BOT_TOKEN || !GROUP_ID) {
      return new Response('Missing ENV', { status: 500 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/webhook') {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response('OK');
      } catch (e) {
        return new Response('Bad Request', { status: 400 });
      }
    }

    if (url.pathname === '/setwebhook') {
      const webhookUrl = `${url.origin}/webhook`;

      const tg = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: webhookUrl
        })
      });

      return new Response(await tg.text());
    }

    return new Response('running');
  }
};

async function handleUpdate(update, env) {

  if (update.message) {
    await onMessage(update.message, env);
  }

  if (update.callback_query) {
    await onCallback(update.callback_query, env);
  }
}

async function onMessage(message, env) {

  const chatId = message.chat.id.toString();
  const text = message.text || '';

  const messageKey = `${chatId}:${message.message_id}`;

  const firstProcess = await markMessageProcessed(env, messageKey);
  if (!firstProcess) {
    return;
  }

  // 群内消息 -> 转发用户
  if (chatId === GROUP_ID) {
    return await handleGroupMessage(message, env);
  }

  // 用户命令
  if (text === '/menu') {
    return await sendMenu(chatId);
  }

  if (text === '/help') {
    return await sendHelp(chatId);
  }

  if (text === '/status') {
    return await sendStatus(chatId);
  }

  // 私聊用户验证：有效期 1 小时。过期后重新验证，并清理旧 topic 绑定。
  const verifyResult = await checkUserVerification(env, chatId, text);

  if (verifyResult === 'passed') {
    await sendText(chatId, '✅ 验证成功，请发送您的问题。');
    return;
  }

  if (verifyResult !== true) {
    await sendVerificationPrompt(chatId);
    return;
  }

  // 私聊 start：已验证用户再次 /start，只发送欢迎语，不转发到客服群
  if (text === '/start') {

    await sendText(chatId,
`✨✨✨✨✨
老板好！

这里是【号多多】客服系统
有什么问题 直接发给我就行。

人工客服看到后会第一时间回复您`);
    return;
  }

  const userInfo = await getUserInfo(chatId);

  return await sendUserMessageToService(env, chatId, userInfo, message, text);
}

async function handleGroupMessage(message, env) {

  const text = message.text || '';

  if (text === '/admin' && message.message_thread_id) {
    return await sendAdminPanel(GROUP_ID, message.message_thread_id);
  }

  let privateChatId = null;

  // 优先按论坛话题找用户
  if (message.message_thread_id) {
    privateChatId = await getPrivateChatId(env, message.message_thread_id);
  }

  // 兜底：如果消息落到了总群，客服用“回复”这条消息，也能找到用户
  if (!privateChatId && message.reply_to_message?.message_id) {
    privateChatId = await getPrivateChatIdByReplyMessage(
      env,
      message.reply_to_message.message_id
    );
  }

  if (!privateChatId) {
    return;
  }

  return await copyToPrivateChat(
    privateChatId,
    message
  );
}

async function sendUserMessageToService(env, chatId, userInfo, message, text) {

  let topicId = await ensureTopic(
    env,
    chatId,
    userInfo
  );

  if (!topicId) {
    return await sendText(chatId, '创建会话失败');
  }

  let result = await sendUserMessageToExistingTopic(
    env,
    topicId,
    chatId,
    userInfo,
    message,
    text
  );

  if (result === true) {
    return;
  }

  // 旧 topic 可能被客服删除，或消息被 Telegram 落到总群。
  // 清理旧绑定后重新建新话题，再发一次。
  await resetTopicMap(env, chatId);

  topicId = await ensureTopic(
    env,
    chatId,
    userInfo
  );

  if (!topicId) {
    return await sendText(chatId, '会话已重建失败，请稍后再试');
  }

  await sendUserMessageToExistingTopic(
    env,
    topicId,
    chatId,
    userInfo,
    message,
    text
  );
}

async function sendUserMessageToExistingTopic(env, topicId, chatId, userInfo, message, text) {

  if (text) {

    const safeNickname = escapeMarkdown(userInfo.nickname);
    const safeText = escapeMarkdown(text);

    const response = await sendTopicMessage(
      topicId,
`${safeNickname}：

${safeText}`
    );

    const data = await safeTelegramJson(response);

    if (!isTopicSendOk(data, topicId)) {
      await deleteTelegramMessageIfPossible(data);
      return false;
    }

    await saveReplyMap(
      env,
      data.result.message_id,
      chatId,
      topicId
    );

    return true;
  }

  const response = await copyToTopic(
    topicId,
    message
  );

  const data = await safeTelegramJson(response);

  if (!data?.ok) {
    return false;
  }

  if (data.result?.message_id) {
    await saveReplyMap(
      env,
      data.result.message_id,
      chatId,
      topicId
    );
  }

  return true;
}

function isTopicSendOk(data, topicId) {

  if (!data?.ok || !data.result?.message_id) {
    return false;
  }

  // 正常发进话题时，Telegram 返回的 message_thread_id 应该等于目标 topicId。
  // 如果没有 message_thread_id，通常说明消息落到了总群，必须重建会话。
  return String(data.result.message_thread_id || '') === String(topicId);
}

async function onCallback(callback, env) {

  const data = callback.data;
  const chatId = callback.message.chat.id.toString();

  const callbackKey = `${chatId}:${callback.id}`;

  if (processedCallbacks.has(callbackKey)) {
    return;
  }

  processedCallbacks.add(callbackKey);

  if (processedCallbacks.size > 5000) {
    processedCallbacks.clear();
  }

  if (data === 'user_help') {
    await sendHelp(chatId);
  }

  if (data === 'user_status') {
    await sendStatus(chatId);
  }

  if (data === 'user_about') {
    await sendAbout(chatId);
  }

  await fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callback_query_id: callback.id
    })
  });
}

async function ensureTopic(env, chatId, userInfo) {

  const existing = await env.D1.prepare(
`SELECT topic_id
FROM topic_map
WHERE chat_id = ?`
  )
  .bind(chatId)
  .first();

  if (existing?.topic_id) {
    return existing.topic_id;
  }

  const tg = await fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: GROUP_ID,
      name: userInfo.nickname
    })
  });

  const data = await tg.json();

  if (!data.ok) {
    return null;
  }

  const topicId = data.result.message_thread_id;

  await env.D1.prepare(
`INSERT INTO topic_map (chat_id, topic_id)
VALUES (?, ?)`
  )
  .bind(chatId, topicId)
  .run();

  await sendTopicMessage(
    topicId,
`👤 新用户

昵称：${escapeMarkdown(userInfo.nickname)}
用户名：@${escapeMarkdown(userInfo.username)}
ID：${chatId}`
  );

  return topicId;
}

async function getPrivateChatId(env, topicId) {

  const row = await env.D1.prepare(
`SELECT chat_id
FROM topic_map
WHERE topic_id = ?`
  )
  .bind(topicId)
  .first();

  return row?.chat_id || null;
}

async function ensureVerificationTable(env) {

  if (verifiedTableReady) {
    return;
  }

  await env.D1.prepare(
`CREATE TABLE IF NOT EXISTS verified_users (
  chat_id TEXT PRIMARY KEY,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  verified_until INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
)`
  ).run();

  const info = await env.D1.prepare(
`PRAGMA table_info(verified_users)`
  ).all();

  const columns = (info.results || []).map((col) => col.name);

  if (!columns.includes('verified_until')) {
    try {
      await env.D1.prepare(
`ALTER TABLE verified_users ADD COLUMN verified_until INTEGER`
      ).run();
    } catch (e) {
      // 并发请求可能同时执行 ALTER；如果另一个实例已经加过列，这里忽略即可。
    }
  }

  verifiedTableReady = true;
}

async function checkUserVerification(env, chatId, text) {

  await ensureVerificationTable(env);

  const now = Math.floor(Date.now() / 1000);

  const row = await env.D1.prepare(
`SELECT verified, verified_until
FROM verified_users
WHERE chat_id = ?`
  )
  .bind(chatId)
  .first();

  if (row?.verified === 1 && row?.verified_until && row.verified_until > now) {
    return true;
  }

  // 验证过期：清理旧 topic，下一轮验证后重新创建新话题。
  if (row?.verified === 1 && (!row.verified_until || row.verified_until <= now)) {
    await expireVerification(env, chatId);
    await resetTopicMap(env, chatId);
  }

  const input = (text || '').trim();

  if (input === VERIFY_CODE) {

    const verifiedUntil = now + VERIFY_TTL_SECONDS;

    await env.D1.prepare(
`INSERT INTO verified_users (
  chat_id,
  verified,
  verified_at,
  verified_until,
  fail_count,
  updated_at
)
VALUES (?, 1, ?, ?, 0, ?)
ON CONFLICT(chat_id) DO UPDATE SET
  verified = 1,
  verified_at = excluded.verified_at,
  verified_until = excluded.verified_until,
  fail_count = 0,
  updated_at = excluded.updated_at`
    )
    .bind(chatId, now, verifiedUntil, now)
    .run();

    // 重新验证代表新一轮会话，清掉旧话题绑定，避免复用已删除的 topic。
    await resetTopicMap(env, chatId);

    return 'passed';
  }

  await env.D1.prepare(
`INSERT INTO verified_users (
  chat_id,
  verified,
  fail_count,
  updated_at
)
VALUES (?, 0, 1, ?)
ON CONFLICT(chat_id) DO UPDATE SET
  fail_count = fail_count + 1,
  updated_at = excluded.updated_at`
  )
  .bind(chatId, now)
  .run();

  return false;
}

async function expireVerification(env, chatId) {

  const now = Math.floor(Date.now() / 1000);

  await env.D1.prepare(
`UPDATE verified_users
SET verified = 0,
    updated_at = ?
WHERE chat_id = ?`
  )
  .bind(now, chatId)
  .run();
}

async function sendVerificationPrompt(chatId) {
  const VERIFY_TXT = `🔰 号多多｜HDD888

宝子，请先完成真人验证 👇

📩 请直接回复数字：${VERIFY_CODE}

验证通过后，即可与小二沟通 😉

⏱ 验证有效期：1 小时`;

  return await sendText(chatId, VERIFY_TXT);
}

async function sendMenu(chatId) {

  await fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: '📋 功能菜单',
      reply_markup: {
        inline_keyboard: USER_MENU_BUTTONS
      }
    })
  });
}

async function sendHelp(chatId) {

  await sendText(
    chatId,
`❓ 帮助说明

直接发送消息即可联系客服

支持：
- 图片
- 视频
- 文件
- 文字`
  );
}

async function sendStatus(chatId) {

  await sendText(
    chatId,
`📊 当前状态正常`
  );
}

async function sendAbout(chatId) {

  await sendText(
    chatId,
`ℹ️ 号多多客服机器人

Cloudflare Workers + Telegram`
  );
}

async function sendAdminPanel(chatId, topicId) {

  await fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_thread_id: topicId,
      text: '⚙️ 管理面板',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '刷新',
              callback_data: 'refresh'
            }
          ]
        ]
      }
    })
  });
}

async function sendTopicMessage(topicId, text) {

  return fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: GROUP_ID,
      message_thread_id: topicId,
      text,
      parse_mode: 'MarkdownV2'
    })
  });
}

async function sendText(chatId, text) {

  return fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

async function copyToTopic(topicId, message) {

  return fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: GROUP_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      message_thread_id: topicId
    })
  });
}

async function copyToPrivateChat(chatId, message) {

  return fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    })
  });
}

async function getUserInfo(chatId) {

  const tg = await fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/getChat`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId
    })
  });

  const data = await tg.json();

  if (!data.ok) {

    return {
      username: `user_${chatId}`,
      nickname: `User_${chatId}`
    };
  }

  const result = data.result;

  return {
    username: result.username || `user_${chatId}`,
    nickname:
      result.first_name
      ? `${result.first_name} ${result.last_name || ''}`.trim()
      : result.username || `User_${chatId}`
  };
}

function escapeMarkdown(text) {

  return String(text || '').replace(
/[_*[\]()~`>#+=|{}.!-]/g,
'\\$&'
  );
}

async function markMessageProcessed(env, messageKey) {

  await ensureProcessedTable(env);

  const now = Math.floor(Date.now() / 1000);

  const result = await env.D1.prepare(
`INSERT OR IGNORE INTO processed_messages (message_key, created_at)
VALUES (?, ?)`
  ).bind(messageKey, now).run();

  return result.meta.changes > 0;
}

async function ensureProcessedTable(env) {

  if (processedTableReady) {
    return;
  }

  await env.D1.prepare(
`CREATE TABLE IF NOT EXISTS processed_messages (
  message_key TEXT PRIMARY KEY,
  created_at INTEGER
)`
  ).run();

  processedTableReady = true;
}

async function ensureReplyMapTable(env) {

  if (replyMapTableReady) {
    return;
  }

  await env.D1.prepare(
`CREATE TABLE IF NOT EXISTS reply_map (
  group_message_id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  topic_id INTEGER,
  created_at INTEGER
)`
  ).run();

  replyMapTableReady = true;
}

async function saveReplyMap(env, groupMessageId, chatId, topicId) {

  if (!groupMessageId) {
    return;
  }

  await ensureReplyMapTable(env);

  const now = Math.floor(Date.now() / 1000);

  await env.D1.prepare(
`INSERT INTO reply_map (
  group_message_id,
  chat_id,
  topic_id,
  created_at
)
VALUES (?, ?, ?, ?)
ON CONFLICT(group_message_id) DO UPDATE SET
  chat_id = excluded.chat_id,
  topic_id = excluded.topic_id,
  created_at = excluded.created_at`
  )
  .bind(groupMessageId, chatId, topicId, now)
  .run();
}

async function getPrivateChatIdByReplyMessage(env, groupMessageId) {

  await ensureReplyMapTable(env);

  const row = await env.D1.prepare(
`SELECT chat_id
FROM reply_map
WHERE group_message_id = ?`
  )
  .bind(groupMessageId)
  .first();

  return row?.chat_id || null;
}

async function resetTopicMap(env, chatId) {

  await env.D1.prepare(
`DELETE FROM topic_map
WHERE chat_id = ?`
  )
  .bind(chatId)
  .run();
}

async function safeTelegramJson(response) {
  try {
    return await response.json();
  } catch (e) {
    return null;
  }
}

async function deleteTelegramMessageIfPossible(data) {

  const messageId = data?.result?.message_id;

  if (!messageId) {
    return;
  }

  await fetch(
`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`,
{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: GROUP_ID,
      message_id: messageId
    })
  });
}
