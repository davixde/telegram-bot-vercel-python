from telegram import (
    KeyboardButton, 
    ReplyKeyboardMarkup, 
    InlineKeyboardButton, 
    InlineKeyboardMarkup, 
    Update, 
    WebAppInfo, 
    BotCommand, 
    MenuButtonWebApp
)
from telegram.ext import Application, CommandHandler, ContextTypes
from os import getenv

WEBAPP_URL = getenv("WEBAPP_URL", "https://telegram-bot-vercel-python.vercel.app/webapp/")

# Global flag to prevent re-running API setup on every webhook execution in serverless environments
_SETUP_DONE = False

async def setup_bot(application: Application) -> None:
    """Configures bot settings, commands, and persistent menu button once on startup."""
    global _SETUP_DONE
    if _SETUP_DONE:
        return

    # 1. Set command suggestions (auto-complete list when typing '/')
    commands = [
        BotCommand("start", "Start the bot and view interface"),
        BotCommand("map", "Open the interactive piano map"),
        BotCommand("nearest", "Find public pianos near you"),
        BotCommand("add", "Add a new piano to the map"),
        BotCommand("modify", "Update details of an existing piano"),
        BotCommand("remove", "Report a piano that is no longer there"),
        BotCommand("stats", "View global mapping statistics"),
        BotCommand("help", "Get guidance on how to use the bot"),
    ]
    await application.bot.set_my_commands(commands)

    # 2. Set the "What can this bot do?" description (shown before starting the bot)
    await application.bot.set_my_description(
        "Welcome! This bot helps you find, map, and update public pianos around the world on OpenStreetMap."
    )

    # 3. Configure the persistent bottom-left menu button to open the Mini App directly
    await application.bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(
            text="Open Map",
            web_app=WebAppInfo(url=WEBAPP_URL)
        )
    )
    _SETUP_DONE = True


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Greets the user and lists available commands with an inline map button."""
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="🎹 Open Piano Map", web_app=WebAppInfo(url=WEBAPP_URL))]
    ])
    
    welcome_text = (
        "👋 <b>Welcome to the Public Piano Map Bot!</b>\n\n"
        "Discover, play, and contribute public pianos to OpenStreetMap.\n\n"
        "<b>Available Commands:</b>\n"
        "📍 /map - Open the interactive map\n"
        "🔍 /nearest - Find pianos near your location\n"
        "➕ /add - Register a new piano\n"
        "✏️ /modify - Edit piano specifications\n"
        "❌ /remove - Report a missing or broken piano\n"
        "📊 /stats - Check global mapping stats\n"
        "❓ /help - Get assistance\n\n"
        "Click the button below or use the 'Open Map' menu button to start!"
    )
    await update.message.reply_html(text=welcome_text, reply_markup=keyboard)


async def map_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Sends an inline keyboard button directly under the message to launch the Mini App."""
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="🗺️ Open Map", web_app=WebAppInfo(url=WEBAPP_URL))]
    ])
    await update.message.reply_html(
        text="Click below to open the interactive public piano map:",
        markup=keyboard
    )


async def nearest(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Requests user location to calculate and find the nearest pianos."""
    keyboard = ReplyKeyboardMarkup(
        [[KeyboardButton(text="📍 Share Location", request_location=True)]],
        resize_keyboard=True,
        one_time_keyboard=True
    )
    await update.message.reply_html(
        text="Please share your location to search for public pianos nearby:",
        reply_markup=keyboard
    )


async def add(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Instructs users how to add a piano using the Mini App interface."""
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="➕ Add via Map", web_app=WebAppInfo(url=f"{WEBAPP_URL}?action=add"))]
    ])
    await update.message.reply_html(
        text="To register a new piano, open the map and select the location:",
        reply_markup=keyboard
    )


async def modify(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Instructs users how to modify a piano."""
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="✏️ Edit on Map", web_app=WebAppInfo(url=WEBAPP_URL))]
    ])
    await update.message.reply_html(
        text="To modify a piano, select its pin on the map and click 'Edit details':",
        reply_markup=keyboard
    )


async def remove(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Instructs users how to report/remove a piano."""
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="❌ Report on Map", web_app=WebAppInfo(url=WEBAPP_URL))]
    ])
    await update.message.reply_html(
        text="If a piano is no longer there, select its pin on the map and click 'Report missing':",
        reply_markup=keyboard
    )


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Displays mock or dynamic stats of mapped pianos."""
    await update.message.reply_html(
        text="📊 <b>Global Public Piano Stats:</b>\n\n"
             "• Pianos mapped globally: <i>Loading...</i>\n"
             "• Your contributions: 0"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Provides general guidelines for mapping pianos."""
    await update.message.reply_html(
        text="<b>How to use this bot:</b>\n\n"
             "1. Use the /map command or the menu button to look around.\n"
             "2. To add a piano, tap /add or do it directly inside the app.\n"
             "3. Keep information accurate: indicate if a piano is in a train station, shopping center, or street."
    )


async def bot_tele(update_data):
    application = Application.builder().token(getenv("TOKEN")).build()
    
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("map", map_command))
    application.add_handler(CommandHandler("nearest", nearest))
    application.add_handler(CommandHandler("add", add))
    application.add_handler(CommandHandler("modify", modify))
    application.add_handler(CommandHandler("remove", remove))
    application.add_handler(CommandHandler("stats", stats))
    application.add_handler(CommandHandler("help", help_command))

    # Initialize menu buttons and command configs
    await setup_bot(application)

    update = Update.de_json(update_data, bot=application.bot)
    async with application:
        await application.process_update(update)