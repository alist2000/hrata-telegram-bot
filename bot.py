"""
Telegram AI Bot — Main entry point.

Features:
  ✅ Free AI answers via Google Gemini
  ✅ 5 questions/day per user
  ✅ Mandatory channel membership check
  ✅ SQLite database for users, questions, answers
  ✅ Admin commands for bot management
"""

import os
import logging
from dotenv import load_dotenv

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ChatMember
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes,
)
from telegram.constants import ParseMode, ChatMemberStatus

import database as db
from ai_provider import ask_gemini, configure_gemini

# ─── Load Config ───────────────────────────────────────────────
load_dotenv()

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
REQUIRED_CHANNEL = os.getenv("REQUIRED_CHANNEL", "").strip().lstrip("@")
DAILY_LIMIT = int(os.getenv("DAILY_QUESTION_LIMIT", "5"))

# Admin users (can be numeric IDs or usernames without @)
ADMIN_IDS = set()
ADMIN_USERNAMES = set()
for _raw_admin in os.getenv("ADMIN_IDS", "").split(","):
    _admin_val = _raw_admin.strip().lstrip("@")
    if not _admin_val:
        continue
    if _admin_val.isdigit():
        ADMIN_IDS.add(int(_admin_val))
    else:
        ADMIN_USERNAMES.add(_admin_val.lower())

# ─── Logging ───────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════
#  HELPER: Check channel membership
# ═══════════════════════════════════════════════════════════════
async def check_channel_membership(user_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Check if user is a member of the required channel."""
    if not REQUIRED_CHANNEL:
        return True  # No channel requirement configured

    try:
        # Support both @username and numeric chat_id
        channel_id = REQUIRED_CHANNEL if REQUIRED_CHANNEL.startswith("-") else f"@{REQUIRED_CHANNEL}"
        member = await context.bot.get_chat_member(chat_id=channel_id, user_id=user_id)

        is_member = member.status in [
            ChatMemberStatus.MEMBER,
            ChatMemberStatus.ADMINISTRATOR,
            ChatMemberStatus.OWNER,
        ]

        # Update membership status in DB
        await db.set_channel_membership(user_id, is_member)
        return is_member

    except Exception as e:
        logger.warning(f"Channel membership check failed for {user_id}: {e}")
        return False


def get_join_channel_keyboard() -> InlineKeyboardMarkup:
    """Create an inline keyboard with a button to join the channel + verify."""
    channel_link = REQUIRED_CHANNEL if REQUIRED_CHANNEL.startswith("-") else REQUIRED_CHANNEL
    buttons = [
        [InlineKeyboardButton("📢 Join Channel", url=f"https://t.me/{channel_link}")],
        [InlineKeyboardButton("✅ I've Joined — Verify", callback_data="verify_membership")],
    ]
    return InlineKeyboardMarkup(buttons)


# ═══════════════════════════════════════════════════════════════
#  COMMAND: /start
# ═══════════════════════════════════════════════════════════════
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle the /start command."""
    user = update.effective_user
    await db.upsert_user(user.id, user.username, user.first_name, user.last_name)

    # Check channel membership
    is_member = await check_channel_membership(user.id, context)

    if not is_member:
        await update.message.reply_text(
            f"👋 Welcome **{user.first_name}**!\n\n"
            f"To use this bot, you must first join our channel.\n"
            f"After joining, tap **\"I've Joined\"** to verify.\n\n"
            f"📢 Channel: @{REQUIRED_CHANNEL}",
            reply_markup=get_join_channel_keyboard(),
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    remaining = DAILY_LIMIT - await db.get_daily_usage(user.id)
    await update.message.reply_text(
        f"👋 Welcome back **{user.first_name}**!\n\n"
        f"🤖 I'm your AI assistant. Just send me any question!\n\n"
        f"📊 You have **{remaining}/{DAILY_LIMIT}** questions remaining today.\n\n"
        f"Commands:\n"
        f"/ask <question> — Ask a question\n"
        f"/remaining — Check remaining questions\n"
        f"/history — View your recent questions\n"
        f"/help — Show help",
        parse_mode=ParseMode.MARKDOWN,
    )


# ═══════════════════════════════════════════════════════════════
#  CALLBACK: Verify membership button
# ═══════════════════════════════════════════════════════════════
async def verify_membership_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle the 'I've Joined' verification button."""
    query = update.callback_query

    user = query.from_user
    is_member = await check_channel_membership(user.id, context)

    if is_member:
        await query.answer("✅ Membership confirmed!", show_alert=False)
        remaining = DAILY_LIMIT - await db.get_daily_usage(user.id)
        try:
            await query.edit_message_text(
                f"✅ **Membership verified!** Welcome, {user.first_name}!\n\n"
                f"🤖 You can now ask me questions.\n"
                f"📊 You have **{remaining}/{DAILY_LIMIT}** questions today.\n\n"
                f"Just type your question or use /ask <question>",
                parse_mode=ParseMode.MARKDOWN,
            )
        except Exception:
            pass
    else:
        await query.answer("❌ You haven't joined the channel yet!", show_alert=True)
        try:
            await query.edit_message_text(
                f"❌ You haven't joined the channel yet!\n\n"
                f"Please join @{REQUIRED_CHANNEL} first, then click Verify below.",
                reply_markup=get_join_channel_keyboard(),
                parse_mode=ParseMode.MARKDOWN,
            )
        except Exception:
            # If the text is already identical, Telegram raises 'Message is not modified'
            pass


# ═══════════════════════════════════════════════════════════════
#  COMMAND: /remaining
# ═══════════════════════════════════════════════════════════════
async def remaining_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show remaining questions for today."""
    user = update.effective_user
    used = await db.get_daily_usage(user.id)
    remaining = max(0, DAILY_LIMIT - used)
    await update.message.reply_text(
        f"📊 **Daily Question Limit**\n\n"
        f"Used: {used}/{DAILY_LIMIT}\n"
        f"Remaining: **{remaining}**\n\n"
        f"{'💡 Limits reset at midnight.' if remaining > 0 else '⏰ Come back tomorrow for more questions!'}",
        parse_mode=ParseMode.MARKDOWN,
    )


# ═══════════════════════════════════════════════════════════════
#  COMMAND: /history
# ═══════════════════════════════════════════════════════════════
async def history_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show user's recent question history."""
    user = update.effective_user
    history = await db.get_user_history(user.id, limit=5)

    if not history:
        await update.message.reply_text("📭 You haven't asked any questions yet!")
        return

    text = "📜 **Your Recent Questions:**\n\n"
    for i, entry in enumerate(history, 1):
        q = entry["question"][:80] + ("..." if len(entry["question"]) > 80 else "")
        a = entry["answer"][:100] + ("..." if len(entry["answer"]) > 100 else "")
        text += f"**{i}. Q:** {q}\n**A:** {a}\n\n"

    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)


# ═══════════════════════════════════════════════════════════════
#  COMMAND: /help
# ═══════════════════════════════════════════════════════════════
async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show help information."""
    await update.message.reply_text(
        "🤖 **AI Bot Help**\n\n"
        "**How to use:**\n"
        "Simply type your question and send it!\n\n"
        "**Commands:**\n"
        "/start — Start the bot\n"
        "/ask <question> — Ask a question\n"
        "/remaining — Check remaining daily questions\n"
        "/history — View recent questions\n"
        "/help — Show this help\n\n"
        f"**Limits:**\n"
        f"• {DAILY_LIMIT} questions per day\n"
        f"• Must be a member of @{REQUIRED_CHANNEL}\n\n"
        "💡 Questions reset daily at midnight.",
        parse_mode=ParseMode.MARKDOWN,
    )


# ═══════════════════════════════════════════════════════════════
#  CORE: Handle questions (both /ask and plain text)
# ═══════════════════════════════════════════════════════════════
async def handle_question(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Process a user's question through the AI."""
    user = update.effective_user
    await db.upsert_user(user.id, user.username, user.first_name, user.last_name)

    # 1. Check if user is blocked
    if await db.is_user_blocked(user.id):
        await update.message.reply_text("🚫 Your access has been suspended. Contact an admin.")
        return

    # 2. Check channel membership
    is_member = await check_channel_membership(user.id, context)
    if not is_member:
        await update.message.reply_text(
            f"⚠️ You need to join our channel first!\n\n"
            f"Join @{REQUIRED_CHANNEL} and then verify:",
            reply_markup=get_join_channel_keyboard(),
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # 3. Check daily limit
    used = await db.get_daily_usage(user.id)
    if used >= DAILY_LIMIT:
        await update.message.reply_text(
            f"⏳ You've reached your daily limit of **{DAILY_LIMIT} questions**.\n\n"
            f"Come back tomorrow! Limits reset at midnight. 🌙",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # 4. Extract the question
    question = update.message.text
    if question.startswith("/ask"):
        question = question[4:].strip()
        if not question:
            await update.message.reply_text("❓ Please provide a question after /ask\n\nExample: `/ask What is Python?`", parse_mode=ParseMode.MARKDOWN)
            return

    if len(question) < 2:
        await update.message.reply_text("❓ Please ask a longer question.")
        return

    # 5. Send "typing" indicator and process
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="typing")

    # 6. Ask the AI
    answer, tokens = await ask_gemini(question)

    # 7. Save to database
    await db.increment_daily_usage(user.id)
    await db.save_question(user.id, question, answer, tokens)

    # 8. Send the answer with remaining count
    remaining = DAILY_LIMIT - (used + 1)
    footer = f"\n\n---\n📊 _{remaining}/{DAILY_LIMIT} questions remaining today_"

    # Telegram has a 4096 char limit per message
    full_response = answer + footer
    if len(full_response) > 4000:
        # Split long responses
        await update.message.reply_text(answer[:4000])
        if len(answer) > 4000:
            await update.message.reply_text(answer[4000:])
        await update.message.reply_text(f"📊 _{remaining}/{DAILY_LIMIT} questions remaining today_", parse_mode=ParseMode.MARKDOWN)
    else:
        await update.message.reply_text(full_response, parse_mode=ParseMode.MARKDOWN)


async def ask_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle the /ask command — just routes to handle_question."""
    await handle_question(update, context)


# ═══════════════════════════════════════════════════════════════
#  ADMIN COMMANDS
# ═══════════════════════════════════════════════════════════════
def is_admin(user) -> bool:
    """Check if a user is an admin by ID or username."""
    if getattr(user, "id", None) in ADMIN_IDS:
        return True
    username = getattr(user, "username", "")
    if username and username.lower() in ADMIN_USERNAMES:
        return True
    return False


async def admin_stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show bot statistics (admin only)."""
    if not is_admin(update.effective_user):
        await update.message.reply_text("🚫 Admin access required.")
        return

    stats = await db.get_stats()
    await update.message.reply_text(
        f"📊 **Bot Statistics**\n\n"
        f"👥 Total users: {stats['total_users']}\n"
        f"📢 Channel members: {stats['channel_members']}\n"
        f"🟢 Active today: {stats['active_today']}\n"
        f"❓ Total questions: {stats['total_questions']}\n"
        f"📅 Questions today: {stats['questions_today']}",
        parse_mode=ParseMode.MARKDOWN,
    )


async def admin_block_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Block a user: /block <user_id>"""
    if not is_admin(update.effective_user):
        return

    if not context.args:
        await update.message.reply_text("Usage: /block <user_id>")
        return

    try:
        target_id = int(context.args[0])
        await db.block_user(target_id)
        await update.message.reply_text(f"🚫 User {target_id} has been blocked.")
    except ValueError:
        await update.message.reply_text("❌ Invalid user ID.")


async def admin_unblock_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Unblock a user: /unblock <user_id>"""
    if not is_admin(update.effective_user):
        return

    if not context.args:
        await update.message.reply_text("Usage: /unblock <user_id>")
        return

    try:
        target_id = int(context.args[0])
        await db.unblock_user(target_id)
        await update.message.reply_text(f"✅ User {target_id} has been unblocked.")
    except ValueError:
        await update.message.reply_text("❌ Invalid user ID.")


async def admin_users_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """List all users (admin only): /users"""
    if not is_admin(update.effective_user):
        return

    users = await db.get_all_users()
    if not users:
        await update.message.reply_text("No users registered yet.")
        return

    text = "👥 **Registered Users:**\n\n"
    for u in users[:20]:  # Show max 20
        status = "🚫" if u["is_blocked"] else ("📢" if u["is_channel_member"] else "👤")
        name = u["first_name"] or u["username"] or str(u["user_id"])
        text += f"{status} `{u['user_id']}` — {name}\n"

    if len(users) > 20:
        text += f"\n... and {len(users) - 20} more users."

    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)


# ═══════════════════════════════════════════════════════════════
#  ERROR HANDLER
# ═══════════════════════════════════════════════════════════════
async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Log errors caused by updates."""
    err_str = str(context.error)
    if "Message is not modified" in err_str:
        return  # Benign Telegram error when clicking the same button twice

    logger.error(f"Update caused error: {context.error}")
    if update and update.effective_message and not update.callback_query:
        try:
            await update.effective_message.reply_text(
                "❌ An unexpected error occurred. Please try again."
            )
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════
def main():
    """Start the bot."""
    if not BOT_TOKEN:
        print("❌ TELEGRAM_BOT_TOKEN is not set in .env!")
        print("   1. Talk to @BotFather on Telegram to create a bot")
        print("   2. Copy the token to .env file")
        return

    if not REQUIRED_CHANNEL:
        print("⚠️  REQUIRED_CHANNEL is not set — channel check is disabled.")

    # Initialize Gemini
    configure_gemini()

    # Configure proxy if available (e.g. v2ray / local proxy)
    proxy_url = os.getenv("PROXY_URL", "").strip()
    if not proxy_url:
        # Check system proxy
        system_proxy = os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or "http://127.0.0.1:10808"
        proxy_url = system_proxy

    builder = Application.builder().token(BOT_TOKEN)
    if proxy_url:
        builder = builder.proxy(proxy_url).get_updates_proxy(proxy_url)
        print(f"[INFO] Using proxy: {proxy_url}")

    # Build the application
    app = builder.build()

    # ─── Register Handlers ──────────────────────────────────
    # Commands
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("ask", ask_command))
    app.add_handler(CommandHandler("remaining", remaining_command))
    app.add_handler(CommandHandler("history", history_command))

    # Admin commands
    app.add_handler(CommandHandler("stats", admin_stats_command))
    app.add_handler(CommandHandler("block", admin_block_command))
    app.add_handler(CommandHandler("unblock", admin_unblock_command))
    app.add_handler(CommandHandler("users", admin_users_command))

    # Callback queries (inline buttons)
    app.add_handler(CallbackQueryHandler(verify_membership_callback, pattern="^verify_membership$"))

    # Plain text messages → treat as questions
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_question))

    # Error handler
    app.add_error_handler(error_handler)

    # ─── Initialize DB and start ────────────────────────────
    import asyncio

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    async def post_init(application: Application):
        await db.init_db()

    app.post_init = post_init

    print("[INFO] Bot is starting...")
    print(f"[INFO] Required channel: @{REQUIRED_CHANNEL}")
    print(f"[INFO] Daily limit: {DAILY_LIMIT} questions/user")
    print("Press Ctrl+C to stop.\n")

    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
