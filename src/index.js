/**
 * Cloudflare Worker: Telegram AI Bot
 * Powered by:
 *  - Cloudflare Workers (Serverless, 100k requests/day free)
 *  - Cloudflare D1 (Serverless SQLite DB, 5M reads/day free)
 *  - Google Gemini API (Free tier)
 *  - Telegram Webhook
 */

const SYSTEM_PROMPT = `You are a helpful AI assistant in a Telegram bot.
Rules:
- Keep answers SHORT and concise (max 2-3 paragraphs).
- Be friendly and helpful.
- If a question is too complex, give a brief summary and suggest the user research further.
- Do NOT answer anything illegal, harmful, or inappropriate.
- Answer in the SAME language the user asks in.
`;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Telegram AI Bot is running smoothly on Cloudflare Workers!", {
        headers: { "content-type": "text/plain" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      env.DB = env.DB || env.hrata_bot_db;
      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response("Error processing update", { status: 200 });
    }
  },
};

/**
 * Main update router
 */
async function handleTelegramUpdate(update, env) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  if (update.message && update.message.text) {
    await handleMessage(update.message, env);
    return;
  }
}

/**
 * Handle user messages & commands
 */
async function handleMessage(message, env) {
  const user = message.from;
  const chatId = message.chat.id;
  const text = message.text.trim();

  // 1. Upsert user in D1 SQLite
  await upsertUser(user, env);

  // 2. Check if blocked
  if (await isUserBlocked(user.id, env)) {
    await sendTelegramMessage(env, chatId, "🚫 Your access has been suspended. Contact an admin.");
    return;
  }

  // 3. Command: /start
  if (text === "/start") {
    const isMember = await checkChannelMembership(user.id, env);
    if (!isMember) {
      await sendTelegramMessage(
        env,
        chatId,
        `👋 Welcome **${escapeMarkdown(user.first_name)}**!\n\nTo use this bot, you must first join our channel.\nAfter joining, tap **"I've Joined"** to verify.\n\n📢 Channel: @${env.REQUIRED_CHANNEL}`,
        getJoinKeyboard(env.REQUIRED_CHANNEL)
      );
      return;
    }

    const limit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
    const used = await getDailyUsage(user.id, env);
    const remaining = Math.max(0, limit - used);

    await sendTelegramMessage(
      env,
      chatId,
      `👋 Welcome back **${escapeMarkdown(user.first_name)}**!\n\n🤖 I'm your AI assistant. Just send me any question!\n\n📊 You have **${remaining}/${limit}** questions remaining today.\n\nCommands:\n/ask <question> — Ask a question\n/remaining — Check remaining questions\n/history — View your recent questions\n/help — Show help`
    );
    return;
  }

  // 4. Command: /help
  if (text === "/help") {
    const limit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
    await sendTelegramMessage(
      env,
      chatId,
      `🤖 **AI Bot Help**\n\n**How to use:**\nSimply send your question as a message!\n\n**Commands:**\n/start — Start bot\n/ask <question> — Ask question\n/remaining — Check remaining queries\n/history — View recent questions\n/help — Show help\n\n**Limits:**\n• ${limit} questions per day\n• Must be a member of @${env.REQUIRED_CHANNEL}`
    );
    return;
  }

  // 5. Command: /remaining
  if (text === "/remaining") {
    const limit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
    const used = await getDailyUsage(user.id, env);
    const remaining = Math.max(0, limit - used);
    await sendTelegramMessage(
      env,
      chatId,
      `📊 **Daily Question Limit**\n\nUsed: ${used}/${limit}\nRemaining: **${remaining}**\n\n${remaining > 0 ? "💡 Limits reset at midnight." : "⏰ Come back tomorrow for more questions!"}`
    );
    return;
  }

  // 6. Command: /history
  if (text === "/history") {
    const history = await getUserHistory(user.id, env, 5);
    if (!history || history.length === 0) {
      await sendTelegramMessage(env, chatId, "📭 You haven't asked any questions yet!");
      return;
    }

    let out = "📜 **Your Recent Questions:**\n\n";
    history.forEach((item, index) => {
      const q = item.question.length > 80 ? item.question.substring(0, 80) + "..." : item.question;
      const a = item.answer.length > 100 ? item.answer.substring(0, 100) + "..." : item.answer;
      out += `**${index + 1}. Q:** ${escapeMarkdown(q)}\n**A:** ${escapeMarkdown(a)}\n\n`;
    });
    await sendTelegramMessage(env, chatId, out);
    return;
  }

  // 7. Channel membership verification check
  const isMember = await checkChannelMembership(user.id, env);
  if (!isMember) {
    await sendTelegramMessage(
      env,
      chatId,
      `⚠️ You need to join our channel first!\n\nJoin @${env.REQUIRED_CHANNEL} and then verify:`,
      getJoinKeyboard(env.REQUIRED_CHANNEL)
    );
    return;
  }

  // 8. Daily usage quota check
  const limit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
  const used = await getDailyUsage(user.id, env);
  if (used >= limit) {
    await sendTelegramMessage(
      env,
      chatId,
      `⏳ You've reached your daily limit of **${limit} questions**.\n\nCome back tomorrow! Limits reset daily. 🌙`
    );
    return;
  }

  // 9. Extract question text
  let question = text;
  if (question.startsWith("/ask")) {
    question = question.substring(4).trim();
  }
  if (!question || question.length < 2) {
    await sendTelegramMessage(env, chatId, "❓ Please ask a valid question.");
    return;
  }

  // Send typing indicator
  await sendChatAction(env, chatId, "typing");

  // 10. Call Gemini AI
  const answer = await askGemini(question, env);

  // 11. Save to D1 SQLite database
  await incrementDailyUsage(user.id, env);
  await saveQuestion(user.id, question, answer, env);

  // 12. Send reply
  const remaining = limit - (used + 1);
  const reply = `${answer}\n\n---\n📊 _${remaining}/${limit} questions remaining today_`;
  await sendTelegramMessage(env, chatId, reply);
}

/**
 * Handle Callback Query ("Verify" button)
 */
async function handleCallbackQuery(query, env) {
  const user = query.from;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  const isMember = await checkChannelMembership(user.id, env);

  if (isMember) {
    await answerCallbackQuery(env, query.id, "✅ Membership confirmed!", false);
    const limit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
    const used = await getDailyUsage(user.id, env);
    const remaining = Math.max(0, limit - used);

    await editTelegramMessage(
      env,
      chatId,
      messageId,
      `✅ **Membership verified!** Welcome, ${escapeMarkdown(user.first_name)}!\n\n🤖 You can now ask me questions.\n📊 You have **${remaining}/${limit}** questions today.\n\nJust send me any question!`
    );
  } else {
    await answerCallbackQuery(env, query.id, "❌ You haven't joined the channel yet!", true);
  }
}

/**
 * Channel Membership Check via Telegram API
 */
async function checkChannelMembership(userId, env) {
  const channel = env.REQUIRED_CHANNEL.replace(/^@/, "");
  const channelId = channel.startsWith("-") ? channel : `@${channel}`;

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      user_id: userId,
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.warn("getChatMember failed:", data);
    return false;
  }

  const status = data.result.status;
  const isMember = ["member", "administrator", "creator"].includes(status);

  // Cache in D1
  if (env.DB) {
    await env.DB.prepare(
      "UPDATE users SET is_channel_member = ? WHERE user_id = ?"
    ).bind(isMember ? 1 : 0, userId).run();
  }

  return isMember;
}

/**
 * Gemini AI API Request
 */
async function askGemini(question, env) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const payload = {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: question }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }

    if (data.error) {
      console.error("Gemini error payload:", data.error);
      return "⏳ The AI service is currently busy. Please try again shortly.";
    }

    return "❌ Sorry, I could not generate an answer right now.";
  } catch (err) {
    console.error("Gemini fetch exception:", err);
    return "❌ Failed to reach the AI service.";
  }
}

/**
 * Database Functions (Cloudflare D1)
 */
async function upsertUser(user, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO users (user_id, username, first_name, last_name, first_seen, last_active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      last_active = excluded.last_active
  `).bind(user.id, user.username || "", user.first_name || "", user.last_name || "", now, now).run();
}

async function isUserBlocked(userId, env) {
  if (!env.DB) return false;
  const row = await env.DB.prepare("SELECT is_blocked FROM users WHERE user_id = ?").bind(userId).first();
  return Boolean(row?.is_blocked);
}

async function getDailyUsage(userId, env) {
  if (!env.DB) return 0;
  const today = new Date().toISOString().split("T")[0];
  const row = await env.DB.prepare(
    "SELECT question_count FROM daily_usage WHERE user_id = ? AND usage_date = ?"
  ).bind(userId, today).first();
  return row ? row.question_count : 0;
}

async function incrementDailyUsage(userId, env) {
  if (!env.DB) return;
  const today = new Date().toISOString().split("T")[0];
  await env.DB.prepare(`
    INSERT INTO daily_usage (user_id, usage_date, question_count)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, usage_date) DO UPDATE SET
      question_count = question_count + 1
  `).bind(userId, today).run();
}

async function saveQuestion(userId, question, answer, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO questions (user_id, question, answer, asked_at, tokens_used)
    VALUES (?, ?, ?, ?, 0)
  `).bind(userId, question, answer, now).run();
}

async function getUserHistory(userId, env, limit = 5) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(`
    SELECT question, answer, asked_at FROM questions
    WHERE user_id = ?
    ORDER BY asked_at DESC
    LIMIT ?
  `).bind(userId, limit).all();
  return results || [];
}

/**
 * Telegram API Helpers
 */
async function sendTelegramMessage(env, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendChatAction(env, chatId, action) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

async function answerCallbackQuery(env, queryId, text, showAlert = false) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: queryId, text, show_alert: showAlert }),
  });
}

function getJoinKeyboard(channel) {
  const clean = channel.replace(/^@/, "");
  return {
    inline_keyboard: [
      [{ text: "📢 Join Channel", url: `https://t.me/${clean}` }],
      [{ text: "✅ I've Joined — Verify", callback_data: "verify_membership" }],
    ],
  };
}

function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/([_*[\]()~`>#+-=|{}.!])/g, "\\$1");
}
