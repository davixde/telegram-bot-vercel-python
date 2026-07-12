from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from os import getenv

# Define a few command handlers.
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_html(text="hello world!")

async def help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_html(text="help me!")

async def bot_tele(update_data):
    application = Application.builder().token(getenv("TOKEN")).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help))

    update = Update.de_json(update_data, bot=application.bot)
    async with application:
        await application.process_update(update)
