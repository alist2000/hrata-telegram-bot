/**
 * Cloudflare Worker: Telegram AI Bot
 * Persian by default
 * Powered by Gemini & Cloudflare D1
 */

const SYSTEM_PROMPT = `شما یک دستیار هوش مصنوعی مودب، مفید و دقیق در تلگرام هستید.
قوانین:
- پاسخ‌ها را به زبان فارسی روان، کوتاه و دقیق ارائه بده. حداکثر ۲ تا ۳ بند.
- از به کار بردن علامت‌های گیومه غیرضروری و خط فاصله طولانی خودداری کن.
- اگر سوال نیاز به تحقیق بیشتر دارد، خلاصه‌ای بده و راهنمایی کن.
- پاسخ محتوای نامناسب یا خطرناک را نده.
`;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Telegram AI Bot is running smoothly on Cloudflare Workers!", {
        headers: { "content-type": "text/plain; charset=utf-8" },
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
 * Handle user messages & commands in Persian
 */
async function handleMessage(message, env) {
  const user = message.from;
  const chatId = message.chat.id;
  const text = message.text.trim();

  // 1. Upsert user in D1 SQLite
  await upsertUser(user, env);

  // 2. Check if blocked
  if (await isUserBlocked(user.id, env)) {
    await sendTelegramMessage(env, chatId, "دسترسی شما به ربات مسدود شده است. لطفا با پشتیبانی در ارتباط باشید.");
    return;
  }

  // 3. Command: /start
  if (text === "/start") {
    const isMember = await checkChannelMembership(user.id, env);
    if (!isMember) {
      const channelName = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");
      await sendTelegramMessage(
        env,
        chatId,
        `سلام ${escapeMarkdown(user.first_name || "کاربر گرامی")} خوش آمدید.\n\nبرای استفاده از ربات، ابتدا باید در کانال ما عضو شوید:\nکانال: @${channelName}\n\nپس از عضویت، دکمه بررسی عضویت را لمس کنید.`,
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
      `سلام ${escapeMarkdown(user.first_name || "عزیز")} خوش آمدید.\n\nمن دستیار هوش مصنوعی شما هستم. هر سوالی دارید بپرسید تا پاسخ دهم.\n\nسهمیه امروز شما: ${remaining} از ${limit} سوال باقی‌مانده است.\n\nراهنما:\n/ask <سوال> برای پرسیدن سوال\n/remaining مشاهده تعداد سوال باقی‌مانده\n/history مشاهده سوالات اخیر\n/help راهنمای دستورات`
    );
    return;
  }

  // 4. Command: /help
  if (text === "/help") {
    const limit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
    const channelName = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");
    await sendTelegramMessage(
      env,
      chatId,
      `راهنمای ربات هوش مصنوعی:\n\nکافی است متن سوال خود را همینجا ارسال کنید.\n\nدستورات:\n/start شروع مجدد ربات\n/remaining مشاهده باقیمانده سهمیه روزانه\n/history تاریخچه آخرین سوالات شما\n/help نمایش این راهنما\n\nمحدودیت‌ها:\nروزانه ${limit} سوال برای هر کاربر\nعضویت اجباری در کانال @${channelName}`
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
      `گزارش مصرف امروز شما:\nتعداد استفاده شده: ${used} از ${limit}\nتعداد باقی‌مانده: ${remaining} سوال\n\nسهمیه هر شب در ساعت ۲۴ بازنشانی می‌شود.`
    );
    return;
  }

  // 6. Command: /history
  if (text === "/history") {
    const history = await getUserHistory(user.id, env, 5);
    if (!history || history.length === 0) {
      await sendTelegramMessage(env, chatId, "شما هنوز هیچ سوالی نپرسیده‌اید.");
      return;
    }

    let out = "آخرین پرسش‌های شما:\n\n";
    history.forEach((item, index) => {
      const q = item.question.length > 80 ? item.question.substring(0, 80) + "..." : item.question;
      const a = item.answer.length > 100 ? item.answer.substring(0, 100) + "..." : item.answer;
      out += `${index + 1}. پرسش: ${escapeMarkdown(q)}\nپاسخ: ${escapeMarkdown(a)}\n\n`;
    });
    await sendTelegramMessage(env, chatId, out);
    return;
  }

  // 7. Channel membership verification check
  const isMember = await checkChannelMembership(user.id, env);
  if (!isMember) {
    const channelName = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");
    await sendTelegramMessage(
      env,
      chatId,
      `برای دریافت پاسخ ابتدا باید در کانال عضو شوید:\nکانال: @${channelName}`,
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
      `سهمیه ۵ سوال امروز شما به پایان رسیده است. فردا مجددا می‌توانید سوالات جدید خود را مطرح کنید.`
    );
    return;
  }

  // 9. Extract question text
  let question = text;
  if (question.startsWith("/ask")) {
    question = question.substring(4).trim();
  }
  if (!question || question.length < 2) {
    await sendTelegramMessage(env, chatId, "لطفا سوال کامل‌تری بپرسید.");
    return;
  }

  // Send typing indicator
  await sendChatAction(env, chatId, "typing");

  // 10. Call AI
  const answer = await askAI(question, env);

  // 11. Save to D1 SQLite database
  await incrementDailyUsage(user.id, env);
  await saveQuestion(user.id, question, answer, env);

  // 12. Send reply
  const remaining = limit - (used + 1);
  const reply = `${answer}\n\n${remaining} سوال از ${limit} سوال امروز باقی مانده است.`;
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
    await answerCallbackQuery(env, query.id, "عضویت شما با موفقیت تایید شد", false);
    const limit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
    const used = await getDailyUsage(user.id, env);
    const remaining = Math.max(0, limit - used);

    await editTelegramMessage(
      env,
      chatId,
      messageId,
      `عضویت شما تایید شد ${escapeMarkdown(user.first_name || "")} عزیز.\nاکنون می‌توانید سوالات خود را ارسال کنید.\nباقی‌مانده امروز: ${remaining} از ${limit} سوال.`
    );
  } else {
    await answerCallbackQuery(env, query.id, "شما هنوز در کانال عضو نشده‌اید!", true);
  }
}

/**
 * Channel Membership Check via Telegram API
 */
async function checkChannelMembership(userId, env) {
  const channel = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");
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

  if (env.DB) {
    try {
      await env.DB.prepare(
        "UPDATE users SET is_channel_member = ? WHERE user_id = ?"
      ).bind(isMember ? 1 : 0, userId).run();
    } catch (e) {
      console.warn("DB update failed:", e);
    }
  }

  return isMember;
}

/**
 * AI Request: Supports Gemini (default) or Grok / OpenAI-compatible API
 */
async function askAI(question, env) {
  // If GROK / xAI API Key is configured, use Grok
  if (env.GROK_API_KEY) {
    return await askGrok(question, env);
  }

  // Otherwise, use Gemini 3.8 Flash
  return await askGemini(question, env);
}

/**
 * Google Gemini API Handler
 */
async function askGemini(question, env) {
  try {
    const model = env.GEMINI_MODEL || "gemini-3.8-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    
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
        maxOutputTokens: 600,
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
      console.error("Gemini API error:", JSON.stringify(data.error));
      return "متاسفانه در دریافت پاسخ خطایی رخ داد. لطفا چند لحظه بعد دوباره امتحان کنید.";
    }

    return "پاسخی برای این سوال دریافت نشد. لطفا پرسش دیگری مطرح فرمایید.";
  } catch (err) {
    console.error("Gemini fetch exception:", err);
    return "ارتباط با سرویس هوش مصنوعی برقرار نشد. لطفا بعدا تلاش کنید.";
  }
}

/**
 * Grok (xAI) API Handler
 */
async function askGrok(question, env) {
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.GROK_MODEL || "grok-2-latest",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: question },
        ],
        temperature: 0.7,
        max_tokens: 600,
      }),
    });

    const data = await res.json();
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
    console.error("Grok error:", data);
    return "خطا در پردازش توسط گروک. لطفا دقایقی دیگر امتحان کنید.";
  } catch (e) {
    console.error("Grok fetch exception:", e);
    return "ارتباط با سرویس گروک برقرار نشد.";
  }
}

/**
 * Database Functions (Cloudflare D1)
 */
async function upsertUser(user, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO users (user_id, username, first_name, last_name, first_seen, last_active)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        last_active = excluded.last_active
    `).bind(user.id, user.username || "", user.first_name || "", user.last_name || "", now, now).run();
  } catch (e) {
    console.error("upsertUser error:", e);
  }
}

async function isUserBlocked(userId, env) {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare("SELECT is_blocked FROM users WHERE user_id = ?").bind(userId).first();
    return Boolean(row?.is_blocked);
  } catch (e) {
    return false;
  }
}

async function getDailyUsage(userId, env) {
  if (!env.DB) return 0;
  const today = new Date().toISOString().split("T")[0];
  try {
    const row = await env.DB.prepare(
      "SELECT question_count FROM daily_usage WHERE user_id = ? AND usage_date = ?"
    ).bind(userId, today).first();
    return row ? row.question_count : 0;
  } catch (e) {
    return 0;
  }
}

async function incrementDailyUsage(userId, env) {
  if (!env.DB) return;
  const today = new Date().toISOString().split("T")[0];
  try {
    await env.DB.prepare(`
      INSERT INTO daily_usage (user_id, usage_date, question_count)
      VALUES (?, ?, 1)
      ON CONFLICT(user_id, usage_date) DO UPDATE SET
        question_count = question_count + 1
    `).bind(userId, today).run();
  } catch (e) {
    console.error("incrementDailyUsage error:", e);
  }
}

async function saveQuestion(userId, question, answer, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO questions (user_id, question, answer, asked_at, tokens_used)
      VALUES (?, ?, ?, ?, 0)
    `).bind(userId, question, answer, now).run();
  } catch (e) {
    console.error("saveQuestion error:", e);
  }
}

async function getUserHistory(userId, env, limit = 5) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(`
      SELECT question, answer, asked_at FROM questions
      WHERE user_id = ?
      ORDER BY asked_at DESC
      LIMIT ?
    `).bind(userId, limit).all();
    return results || [];
  } catch (e) {
    return [];
  }
}

/**
 * Telegram API Helpers
 */
async function sendTelegramMessage(env, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
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
  const clean = (channel || "").replace(/^@/, "");
  return {
    inline_keyboard: [
      [{ text: "عضویت در کانال", url: `https://t.me/${clean}` }],
      [{ text: "عضو شدم، بررسی کن", callback_data: "verify_membership" }],
    ],
  };
}

function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/([_*[\]()~`>#+=|{}!])/g, "\\$1");
}
