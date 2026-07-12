import asyncio
import json
from django.http import HttpResponse
from .bot import bot_tele

def index(request):
    if request.method != 'POST':
        return HttpResponse("hello world!")

    data = request.body
    try:
        update_data = json.loads(data.decode('utf-8'))
        print("telegram update:", update_data)
        asyncio.run(bot_tele(update_data))
    except Exception as exc:
        print("bot error:", exc)
        return HttpResponse("error", status=500)

    return HttpResponse("ok")
