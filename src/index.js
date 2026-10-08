/**
 * Cloudflare Worker: Telegram AI Bot
 * Persian default language
 * Powered by Gemini / Grok & Cloudflare D1
 *
 * Features:
 *   - Gemini 3.8 Flash with auto-retry on 503
 *   - Optional Grok (xAI) fallback
 *   - Manager panel: reset quotas, set per-user limits, add/remove managers
 *   - Channel membership enforcement
 *   - Daily question limits (global + per-user overrides)
 *   - Full Q&A history in D1 SQLite
 */

const SYSTEM_PROMPT = `شما یک دستیار هوش مصنوعی مودب، مفید و دقیق در تلگرام هستید.
قوانین:
- پاسخ‌ها را به زبان فارسی روان، کوتاه و دقیق ارائه بده. حداکثر ۲ تا ۳ بند.
- از به کار بردن علامت‌های گیومه غیرضروری و خط فاصله طولانی خودداری کن.
- اگر سوال نیاز به تحقیق بیشتر دارد، خلاصه‌ای بده و راهنمایی کن.
- پاسخ محتوای نامناسب یا خطرناک را نده.
`;

// ═══════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Telegram AI Bot is running on Cloudflare Workers.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      env.DB = env.DB || env.hrata_bot_db;
      const update = await request.json();
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(handleUpdate(update, env));
      } else {
        await handleUpdate(update, env);
      }
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Worker top-level error:", err);
      return new Response("OK", { status: 200 });
    }
  },
};

// ═══════════════════════════════════════════════════════════
//  UPDATE ROUTER
// ═══════════════════════════════════════════════════════════
async function handleUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query, env);
    } else if (update.message && update.message.text) {
      await handleMessage(update.message, env);
    }
  } catch (err) {
    console.error("handleUpdate error:", err);
  }
}

// ═══════════════════════════════════════════════════════════
//  MANAGER CHECK
// ═══════════════════════════════════════════════════════════
async function isManager(username, env) {
  if (!username || !env.DB) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT username FROM managers WHERE username = ?"
    ).bind(username.toLowerCase()).first();
    return Boolean(row);
  } catch (e) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//  GET DAILY LIMIT FOR USER (per-user override or global)
// ═══════════════════════════════════════════════════════════
async function getUserDailyLimit(userId, env) {
  const globalLimit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
  if (!env.DB) return globalLimit;
  try {
    const row = await env.DB.prepare(
      "SELECT daily_limit FROM user_limits WHERE user_id = ?"
    ).bind(userId).first();
    return row ? row.daily_limit : globalLimit;
  } catch (e) {
    return globalLimit;
  }
}

// ═══════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════
async function handleMessage(message, env) {
  const user = message.from;
  const chatId = message.chat.id;
  const text = message.text.trim();

  await upsertUser(user, env);

  // Check if blocked
  if (await isUserBlocked(user.id, env)) {
    await tgSend(env, chatId, "دسترسی شما مسدود شده است. با پشتیبانی تماس بگیرید.");
    return;
  }

  const userIsManager = await isManager(user.username, env);

  // ─── Admin commands ──────────────────────────────────
  if (userIsManager) {
    // /start for managers: show role picker
    if (text === "/start") {
      await tgSend(env, chatId,
        `سلام ${user.first_name || "مدیر"} عزیز.\nلطفا نقش ورود خود را انتخاب کنید:`,
        {
          inline_keyboard: [
            [{ text: "پنل مدیریت", callback_data: "admin_panel" }],
            [{ text: "ورود به عنوان کاربر عادی", callback_data: "user_mode" }],
          ],
        }
      );
      return;
    }

    // /admin: open admin panel directly
    if (text === "/admin") {
      await sendAdminPanel(env, chatId);
      return;
    }

    // /reset <user_id>
    if (text.startsWith("/reset")) {
      const targetId = parseInt(text.split(/\s+/)[1], 10);
      if (!targetId) {
        await tgSend(env, chatId, "لطفا شناسه کاربر را وارد کنید.\nمثال: /reset 104748002");
        return;
      }
      await resetUserQuota(targetId, env);
      await tgSend(env, chatId, `سهمیه کاربر ${targetId} با موفقیت بازنشانی شد.`);
      return;
    }

    // /setlimit <user_id> <limit>
    if (text.startsWith("/setlimit")) {
      const parts = text.split(/\s+/);
      const targetId = parseInt(parts[1], 10);
      const newLimit = parseInt(parts[2], 10);
      if (!targetId || !newLimit || newLimit < 1) {
        await tgSend(env, chatId, "لطفا شناسه کاربر و سهمیه جدید را وارد کنید.\nمثال: /setlimit 104748002 10");
        return;
      }
      await setUserLimit(targetId, newLimit, user.username, env);
      await tgSend(env, chatId, `سهمیه روزانه کاربر ${targetId} به ${newLimit} سوال تغییر یافت.`);
      return;
    }

    // /addmanager @username
    if (text.startsWith("/addmanager")) {
      const raw = text.split(/\s+/)[1];
      if (!raw) {
        await tgSend(env, chatId, "لطفا نام کاربری مدیر جدید را وارد کنید.\nمثال: /addmanager @username");
        return;
      }
      const newMgr = raw.replace(/^@/, "").toLowerCase();
      await addManager(newMgr, user.username, env);
      await tgSend(env, chatId, `کاربر @${newMgr} به لیست مدیران اضافه شد.`);
      return;
    }

    // /removemanager @username
    if (text.startsWith("/removemanager")) {
      const raw = text.split(/\s+/)[1];
      if (!raw) {
        await tgSend(env, chatId, "لطفا نام کاربری مدیر را وارد کنید.\nمثال: /removemanager @username");
        return;
      }
      const rmMgr = raw.replace(/^@/, "").toLowerCase();
      await removeManager(rmMgr, env);
      await tgSend(env, chatId, `کاربر @${rmMgr} از لیست مدیران حذف شد.`);
      return;
    }

    // /block <user_id>
    if (text.startsWith("/block")) {
      const targetId = parseInt(text.split(/\s+/)[1], 10);
      if (!targetId) {
        await tgSend(env, chatId, "مثال: /block 104748002");
        return;
      }
      await blockUser(targetId, env);
      await tgSend(env, chatId, `کاربر ${targetId} مسدود شد.`);
      return;
    }

    // /unblock <user_id>
    if (text.startsWith("/unblock")) {
      const targetId = parseInt(text.split(/\s+/)[1], 10);
      if (!targetId) {
        await tgSend(env, chatId, "مثال: /unblock 104748002");
        return;
      }
      await unblockUser(targetId, env);
      await tgSend(env, chatId, `کاربر ${targetId} رفع مسدودیت شد.`);
      return;
    }

    // /stats
    if (text === "/stats") {
      await sendStats(env, chatId);
      return;
    }

    // /users
    if (text === "/users") {
      await sendUsersList(env, chatId);
      return;
    }

    // /managers
    if (text === "/managers") {
      await sendManagersList(env, chatId);
      return;
    }
  }

  // ─── Regular user commands ───────────────────────────
  if (text === "/start") {
    return await handleUserStart(user, chatId, env);
  }
  if (text === "/help") {
    return await handleHelp(chatId, env);
  }
  if (text === "/remaining") {
    return await handleRemaining(user.id, chatId, env);
  }
  if (text === "/history") {
    return await handleHistory(user.id, chatId, env);
  }

  // ─── Question flow ──────────────────────────────────
  await handleQuestion(user, chatId, text, env);
}

// ═══════════════════════════════════════════════════════════
//  CALLBACK HANDLER
// ═══════════════════════════════════════════════════════════
async function handleCallback(query, env) {
  const user = query.from;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // ─── Admin panel ─────────────────────────────────────
  if (data === "admin_panel") {
    await tgAnswerCallback(env, query.id, "پنل مدیریت", false);
    await sendAdminPanel(env, chatId);
    return;
  }

  if (data === "user_mode") {
    await tgAnswerCallback(env, query.id, "حالت کاربر عادی", false);
    await handleUserStart(user, chatId, env);
    return;
  }

  if (data === "admin_stats") {
    await tgAnswerCallback(env, query.id, "", false);
    await sendStats(env, chatId);
    return;
  }

  if (data === "admin_users") {
    await tgAnswerCallback(env, query.id, "", false);
    await sendUsersList(env, chatId);
    return;
  }

  if (data === "admin_managers") {
    await tgAnswerCallback(env, query.id, "", false);
    await sendManagersList(env, chatId);
    return;
  }

  if (data === "admin_help") {
    await tgAnswerCallback(env, query.id, "", false);
    await tgSend(env, chatId,
      `دستورات مدیریتی:\n\n` +
      `/reset <user_id>\nبازنشانی سهمیه روزانه کاربر\n\n` +
      `/setlimit <user_id> <تعداد>\nتغییر سهمیه روزانه کاربر\n\n` +
      `/addmanager @username\nافزودن مدیر جدید\n\n` +
      `/removemanager @username\nحذف مدیر\n\n` +
      `/block <user_id>\nمسدود کردن کاربر\n\n` +
      `/unblock <user_id>\nرفع مسدودیت کاربر\n\n` +
      `/stats\nآمار کلی ربات\n\n` +
      `/users\nلیست کاربران\n\n` +
      `/managers\nلیست مدیران`
    );
    return;
  }

  // ─── Membership verification ─────────────────────────
  if (data === "verify_membership") {
    const isMember = await checkChannelMembership(user.id, env);
    if (isMember) {
      await tgAnswerCallback(env, query.id, "عضویت تایید شد", false);
      const limit = await getUserDailyLimit(user.id, env);
      const used = await getDailyUsage(user.id, env);
      const remaining = Math.max(0, limit - used);
      try {
        await tgEdit(env, chatId, messageId,
          `عضویت شما تایید شد ${user.first_name || ""} عزیز.\nاکنون می‌توانید سوالات خود را ارسال کنید.\nباقی‌مانده امروز: ${remaining} از ${limit} سوال.`
        );
      } catch (e) { /* ignore duplicate edit */ }
    } else {
      await tgAnswerCallback(env, query.id, "شما هنوز در کانال عضو نشده‌اید!", true);
    }
    return;
  }
}

// ═══════════════════════════════════════════════════════════
//  ADMIN PANEL & ACTIONS
// ═══════════════════════════════════════════════════════════
async function sendAdminPanel(env, chatId) {
  await tgSend(env, chatId,
    "پنل مدیریت ربات\n\nدکمه‌های زیر را استفاده کنید یا دستورات متنی را ارسال نمایید.\nبرای مشاهده راهنمای کامل دستورات، دکمه راهنما را لمس کنید.",
    {
      inline_keyboard: [
        [{ text: "آمار ربات", callback_data: "admin_stats" }, { text: "لیست کاربران", callback_data: "admin_users" }],
        [{ text: "لیست مدیران", callback_data: "admin_managers" }, { text: "راهنمای دستورات", callback_data: "admin_help" }],
      ],
    }
  );
}

async function sendStats(env, chatId) {
  if (!env.DB) return;
  try {
    const today = new Date().toISOString().split("T")[0];
    const totalUsers = (await env.DB.prepare("SELECT COUNT(*) as c FROM users").first())?.c || 0;
    const channelMembers = (await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE is_channel_member=1").first())?.c || 0;
    const totalQuestions = (await env.DB.prepare("SELECT COUNT(*) as c FROM questions").first())?.c || 0;
    const todayQuestions = (await env.DB.prepare("SELECT SUM(question_count) as c FROM daily_usage WHERE usage_date=?").bind(today).first())?.c || 0;
    const activeToday = (await env.DB.prepare("SELECT COUNT(DISTINCT user_id) as c FROM daily_usage WHERE usage_date=?").bind(today).first())?.c || 0;
    const totalManagers = (await env.DB.prepare("SELECT COUNT(*) as c FROM managers").first())?.c || 0;

    await tgSend(env, chatId,
      `آمار ربات:\n\n` +
      `کل کاربران: ${totalUsers}\n` +
      `اعضای کانال: ${channelMembers}\n` +
      `مدیران: ${totalManagers}\n` +
      `فعال امروز: ${activeToday}\n` +
      `کل سوالات: ${totalQuestions}\n` +
      `سوالات امروز: ${todayQuestions}`
    );
  } catch (e) {
    console.error("sendStats error:", e);
    await tgSend(env, chatId, "خطا در دریافت آمار.");
  }
}

async function sendUsersList(env, chatId) {
  if (!env.DB) return;
  try {
    const { results } = await env.DB.prepare(
      "SELECT user_id, username, first_name, is_blocked, is_channel_member FROM users ORDER BY last_active DESC LIMIT 20"
    ).all();
    if (!results || results.length === 0) {
      await tgSend(env, chatId, "هنوز کاربری ثبت نشده است.");
      return;
    }
    let out = "لیست کاربران (حداکثر ۲۰ نفر):\n\n";
    for (const u of results) {
      const blocked = u.is_blocked ? " [مسدود]" : "";
      const member = u.is_channel_member ? " [عضو]" : "";
      const name = u.first_name || u.username || String(u.user_id);
      out += `${u.user_id} - ${name}${member}${blocked}\n`;
    }
    await tgSend(env, chatId, out);
  } catch (e) {
    console.error("sendUsersList error:", e);
  }
}

async function sendManagersList(env, chatId) {
  if (!env.DB) return;
  try {
    const { results } = await env.DB.prepare("SELECT username, added_by FROM managers").all();
    if (!results || results.length === 0) {
      await tgSend(env, chatId, "هیچ مدیری ثبت نشده است.");
      return;
    }
    let out = "لیست مدیران:\n\n";
    for (const m of results) {
      out += `@${m.username} (اضافه شده توسط: ${m.added_by})\n`;
    }
    await tgSend(env, chatId, out);
  } catch (e) {
    console.error("sendManagersList error:", e);
  }
}

async function resetUserQuota(userId, env) {
  if (!env.DB) return;
  const today = new Date().toISOString().split("T")[0];
  try {
    await env.DB.prepare("DELETE FROM daily_usage WHERE user_id = ? AND usage_date = ?").bind(userId, today).run();
  } catch (e) {
    console.error("resetUserQuota error:", e);
  }
}

async function setUserLimit(userId, limit, setBy, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO user_limits (user_id, daily_limit, set_by, set_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET daily_limit=excluded.daily_limit, set_by=excluded.set_by, set_at=excluded.set_at
    `).bind(userId, limit, setBy || "admin", now).run();
  } catch (e) {
    console.error("setUserLimit error:", e);
  }
}

async function addManager(username, addedBy, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO managers (username, added_by, added_at) VALUES (?, ?, ?)"
    ).bind(username.toLowerCase(), addedBy || "admin", now).run();
  } catch (e) {
    console.error("addManager error:", e);
  }
}

async function removeManager(username, env) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("DELETE FROM managers WHERE username = ?").bind(username.toLowerCase()).run();
  } catch (e) {
    console.error("removeManager error:", e);
  }
}

async function blockUser(userId, env) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("UPDATE users SET is_blocked = 1 WHERE user_id = ?").bind(userId).run();
  } catch (e) {
    console.error("blockUser error:", e);
  }
}

async function unblockUser(userId, env) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("UPDATE users SET is_blocked = 0 WHERE user_id = ?").bind(userId).run();
  } catch (e) {
    console.error("unblockUser error:", e);
  }
}

// ═══════════════════════════════════════════════════════════
//  USER FLOW HANDLERS
// ═══════════════════════════════════════════════════════════
async function handleUserStart(user, chatId, env) {
  const isMember = await checkChannelMembership(user.id, env);
  const channelName = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");

  if (!isMember) {
    await tgSend(env, chatId,
      `سلام ${user.first_name || "کاربر گرامی"} خوش آمدید.\n\nبرای استفاده از ربات، ابتدا باید در کانال ما عضو شوید:\nکانال: @${channelName}\n\nپس از عضویت، دکمه بررسی عضویت را لمس کنید.`,
      getJoinKeyboard(channelName)
    );
    return;
  }

  const limit = await getUserDailyLimit(user.id, env);
  const used = await getDailyUsage(user.id, env);
  const remaining = Math.max(0, limit - used);

  await tgSend(env, chatId,
    `سلام ${user.first_name || "عزیز"} خوش آمدید.\n\nمن دستیار هوش مصنوعی شما هستم. هر سوالی دارید بپرسید.\n\nسهمیه امروز: ${remaining} از ${limit} سوال باقی‌مانده.\n\nراهنما:\n/remaining مشاهده سهمیه باقی‌مانده\n/history مشاهده سوالات اخیر\n/help راهنمای دستورات`
  );
}

async function handleHelp(chatId, env) {
  const channelName = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");
  const globalLimit = parseInt(env.DAILY_QUESTION_LIMIT || "5", 10);
  await tgSend(env, chatId,
    `راهنمای ربات هوش مصنوعی:\n\nکافی است متن سوال خود را همینجا ارسال کنید.\n\nدستورات:\n/start شروع مجدد ربات\n/remaining مشاهده باقیمانده سهمیه روزانه\n/history تاریخچه آخرین سوالات شما\n/help نمایش این راهنما\n\nمحدودیت‌ها:\nروزانه ${globalLimit} سوال (پیش‌فرض)\nعضویت اجباری در کانال @${channelName}`
  );
}

async function handleRemaining(userId, chatId, env) {
  const limit = await getUserDailyLimit(userId, env);
  const used = await getDailyUsage(userId, env);
  const remaining = Math.max(0, limit - used);
  await tgSend(env, chatId,
    `گزارش مصرف امروز شما:\nاستفاده شده: ${used} از ${limit}\nباقی‌مانده: ${remaining} سوال\n\nسهمیه هر شب ساعت ۲۴ بازنشانی می‌شود.`
  );
}

async function handleHistory(userId, chatId, env) {
  const history = await getUserHistory(userId, env, 5);
  if (!history || history.length === 0) {
    await tgSend(env, chatId, "شما هنوز هیچ سوالی نپرسیده‌اید.");
    return;
  }
  let out = "آخرین پرسش‌های شما:\n\n";
  history.forEach((item, i) => {
    const q = item.question.length > 80 ? item.question.substring(0, 80) + "..." : item.question;
    const a = item.answer.length > 100 ? item.answer.substring(0, 100) + "..." : item.answer;
    out += `${i + 1}. پرسش: ${q}\nپاسخ: ${a}\n\n`;
  });
  await tgSend(env, chatId, out);
}

async function handleQuestion(user, chatId, text, env) {
  // Channel check
  const isMember = await checkChannelMembership(user.id, env);
  if (!isMember) {
    const channelName = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");
    await tgSend(env, chatId,
      `برای دریافت پاسخ ابتدا در کانال عضو شوید:\nکانال: @${channelName}`,
      getJoinKeyboard(channelName)
    );
    return;
  }

  // Daily quota check
  const limit = await getUserDailyLimit(user.id, env);
  const used = await getDailyUsage(user.id, env);
  if (used >= limit) {
    await tgSend(env, chatId,
      `سهمیه ${limit} سوال امروز شما به پایان رسیده است.\nفردا مجددا می‌توانید سوالات جدید خود را مطرح کنید.`
    );
    return;
  }

  // Extract question
  let question = text;
  if (question.startsWith("/ask")) {
    question = question.substring(4).trim();
  }
  if (!question || question.length < 2) {
    await tgSend(env, chatId, "لطفا سوال کامل‌تری بپرسید.");
    return;
  }

  await tgAction(env, chatId, "typing");

  // Ask AI with robust timeout and fallback
  const result = await askAI(question, env);

  if (result.success) {
    // Only consume quota if we successfully got an answer
    await incrementDailyUsage(user.id, env);
    await saveQuestion(user.id, question, result.text, env);

    const remaining = limit - (used + 1);
    await tgSend(env, chatId, `${result.text}\n\n${remaining} سوال از ${limit} سوال امروز باقی مانده است.`);
  } else {
    // Show error gracefully without consuming quota
    await tgSend(env, chatId, result.text);
  }
}

// ═══════════════════════════════════════════════════════════
//  AI PROVIDERS (with timeout & fallback)
// ═══════════════════════════════════════════════════════════
async function fetchWithTimeout(url, options = {}) {
  const { timeout = 8000 } = options; // 8 seconds default timeout
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function askAI(question, env) {
  let answer = null;

  // 1. Try Grok if available
  if (env.GROK_API_KEY) {
    answer = await askGrok(question, env);
    if (answer) return { success: true, text: answer };
  }

  // 2. Try Gemini
  answer = await askGemini(question, env);
  if (answer) return { success: true, text: answer };

  // 3. If all fail, return graceful fallback
  return {
    success: false,
    text: "متاسفانه تمامی سرویس‌های هوش مصنوعی در حال حاضر بیش از حد شلوغ هستند. لطفا چند دقیقه دیگر مجددا تلاش کنید.",
  };
}

async function askGemini(question, env) {
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
    generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
  };

  // Max 2 attempts, quick backoff to avoid Cloudflare 30s limit
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: 8000
      });

      const data = await res.json();

      if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text.trim();
      }

      if (data.error) {
        console.error(`Gemini attempt ${attempt} error:`, JSON.stringify(data.error));
        // Retry on 503 or 429
        if ((data.error.code === 503 || data.error.code === 429) && attempt === 1) {
          await sleep(500); // Only sleep 0.5s
          continue;
        }
      }
    } catch (err) {
      console.error(`Gemini attempt ${attempt} exception:`, err);
      if (attempt === 1) {
        await sleep(500);
        continue;
      }
    }
  }

  return null;
}

async function askGrok(question, env) {
  try {
    const res = await fetchWithTimeout("https://api.x.ai/v1/chat/completions", {
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
      timeout: 8000
    });
    const data = await res.json();
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
    console.error("Grok error:", JSON.stringify(data));
    return null;
  } catch (e) {
    console.error("Grok exception:", e);
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════
//  CHANNEL MEMBERSHIP
// ═══════════════════════════════════════════════════════════
async function checkChannelMembership(userId, env) {
  const channel = (env.REQUIRED_CHANNEL || "").replace(/^@/, "");
  if (!channel) return true;
  const channelId = channel.startsWith("-") ? channel : `@${channel}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelId, user_id: userId }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn("getChatMember failed:", JSON.stringify(data));
      return false;
    }
    const isMember = ["member", "administrator", "creator"].includes(data.result.status);
    if (env.DB) {
      try {
        await env.DB.prepare("UPDATE users SET is_channel_member = ? WHERE user_id = ?").bind(isMember ? 1 : 0, userId).run();
      } catch (e) { /* non-critical */ }
    }
    return isMember;
  } catch (e) {
    console.error("checkChannelMembership exception:", e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//  DATABASE (D1)
// ═══════════════════════════════════════════════════════════
async function upsertUser(user, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO users (user_id, username, first_name, last_name, first_seen, last_active)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, last_active=excluded.last_active
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
  } catch (e) { return false; }
}

async function getDailyUsage(userId, env) {
  if (!env.DB) return 0;
  const today = new Date().toISOString().split("T")[0];
  try {
    const row = await env.DB.prepare("SELECT question_count FROM daily_usage WHERE user_id = ? AND usage_date = ?").bind(userId, today).first();
    return row ? row.question_count : 0;
  } catch (e) { return 0; }
}

async function incrementDailyUsage(userId, env) {
  if (!env.DB) return;
  const today = new Date().toISOString().split("T")[0];
  try {
    await env.DB.prepare(`
      INSERT INTO daily_usage (user_id, usage_date, question_count) VALUES (?, ?, 1)
      ON CONFLICT(user_id, usage_date) DO UPDATE SET question_count = question_count + 1
    `).bind(userId, today).run();
  } catch (e) {
    console.error("incrementDailyUsage error:", e);
  }
}

async function saveQuestion(userId, question, answer, env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO questions (user_id, question, answer, asked_at, tokens_used) VALUES (?, ?, ?, ?, 0)"
    ).bind(userId, question, answer, now).run();
  } catch (e) {
    console.error("saveQuestion error:", e);
  }
}

async function getUserHistory(userId, env, limit = 5) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT question, answer, asked_at FROM questions WHERE user_id = ? ORDER BY asked_at DESC LIMIT ?"
    ).bind(userId, limit).all();
    return results || [];
  } catch (e) { return []; }
}

// ═══════════════════════════════════════════════════════════
//  TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════════════
async function tgSend(env, chatId, text, replyMarkup = null) {
  try {
    const body = { chat_id: chatId, text: text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error("tgSend failed:", JSON.stringify(data));
    return data;
  } catch (err) {
    console.error("tgSend exception:", err);
  }
}

async function tgEdit(env, chatId, messageId, text, replyMarkup = null) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text: text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("tgEdit exception:", err);
  }
}

async function tgAction(env, chatId, action) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (e) { /* non-critical */ }
}

async function tgAnswerCallback(env, queryId, text, showAlert = false) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: queryId, text, show_alert: showAlert }),
    });
  } catch (e) { /* non-critical */ }
}

function getJoinKeyboard(channelName) {
  return {
    inline_keyboard: [
      [{ text: "عضویت در کانال", url: `https://t.me/${channelName}` }],
      [{ text: "عضو شدم، بررسی کن", callback_data: "verify_membership" }],
    ],
  };
}
