from telegram import KeyboardButton, ReplyKeyboardMarkup, Update, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes
from os import getenv

WEBAPP_URL = getenv("WEBAPP_URL", "https://telegram-bot-vercel-python.vercel.app/webapp/")

# Define a few command handlers.
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    button = KeyboardButton(
        text="Apri mini app",
        web_app=WebAppInfo(url=WEBAPP_URL),
    )
    keyboard = ReplyKeyboardMarkup(
        [[button]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )
    await update.message.reply_html(
        text="Ciao! Usa il pulsante qui sotto per aprire la mini app.",
        reply_markup=keyboard,
    )

async def help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_html(text="Invia /start per vedere la mini app.")

async def bot_tele(update_data):
    application = Application.builder().token(getenv("TOKEN")).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help))

    update = Update.de_json(update_data, bot=application.bot)
    async with application:
        await application.process_update(update)
