# Python Telegram Bot Vercel
Telegram bot using based on https://github.com/python-telegram-bot/python-telegram-bot

### Environment Variables
```
TOKEN = Telegram Bot Token
```

### Webhook setup
Telegram must know your app URL before it can forward messages to Vercel. Register the webhook once with:

```bash
curl -F "url=https://your-app.vercel.app/" https://api.telegram.org/bot$TOKEN/setWebhook
```

Check the webhook status with:

```bash
curl https://api.telegram.org/bot$TOKEN/getWebhookInfo
```

### Notes
- Env names are case sensitive
- The app receives Telegram POST updates on `/` and processes them server-side
- If `/start` does not reply, verify webhook registration and check Vercel logs for errors

