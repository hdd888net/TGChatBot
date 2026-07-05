let BOT_TOKEN;
let GROUP_ID;
let MAX_MESSAGES_PER_MINUTE = 40;
let verifiedTableReady = false;

const VERIFY_CODE = '888';

const processedMessages = new Set();
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

  if (processedMessages.has(messageKey)) {
    return;
  }

  processedMessages.add(messageKey);

  if (processedMessages.size > 5000) {
    processedMessages.clear();
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

  // 群内消息 -> 转发用户
  if (chatId === GROUP_ID) {

    if (!message.message_thread_id) {
      return;
    }

    const privateChatId = await getPrivateChatId(
      env,
      message.message_thread_id
    );

    if (!privateChatId) {
      return;
    }

    if (text === '/admin') {
      return await sendAdminPanel(chatId, message.message_thread_id);
    }

    return await copyToPrivateChat(
      privateChatId,
      message
    );
  }

  // 私聊用户验证：未验证用户不创建话题、不转发到客服群
  const verifyResult = await checkUserVerification(env, chatId, text);

  if (verifyResult === 'passed') {
    await sendText(chatId, '✅ 验证成功，您可以发信息了。');
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

  const topicId = await ensureTopic(
    env,
    chatId,
    userInfo
  );

  if (!topicId) {
    return await sendText(chatId, '创建会话失败');
  }

  if (text) {

    const safeText = escapeMarkdown(text);

    await sendTopicMessage(
      topicId,
`${userInfo.nickname}：

${safeText}`
    );

  } else {

    await copyToTopic(
      topicId,
      message
    );
  }
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
  fail_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
)`
  ).run();

  verifiedTableReady = true;
}

async function checkUserVerification(env, chatId, text) {

  await ensureVerificationTable(env);

  const row = await env.D1.prepare(
`SELECT verified
FROM verified_users
WHERE chat_id = ?`
  )
  .bind(chatId)
  .first();

  if (row?.verified === 1) {
    return true;
  }

  const input = (text || '').trim();

  if (input === VERIFY_CODE) {

    const now = Math.floor(Date.now() / 1000);

    await env.D1.prepare(
`INSERT INTO verified_users (
  chat_id,
  verified,
  verified_at,
  fail_count,
  updated_at
)
VALUES (?, 1, ?, 0, ?)
ON CONFLICT(chat_id) DO UPDATE SET
  verified = 1,
  verified_at = excluded.verified_at,
  fail_count = 0,
  updated_at = excluded.updated_at`
    )
    .bind(chatId, now, now)
    .run();

    return 'passed';
  }

  const now = Math.floor(Date.now() / 1000);

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

async function sendVerificationPrompt(chatId) {

  return await sendText(
    chatId,
const VERIFY_TXT =`号多多|HDD888
宝子，请先完成真人验证 👇。

请直接回复数字：${VERIFY_CODE}

验证通过后，即可与客服勾兑小😉。`
  );
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

  return text.replace(
/[_*[\]()~`>#+=|{}.!-]/g,
'\\$&'
  );
}
