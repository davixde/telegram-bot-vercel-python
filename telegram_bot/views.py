import asyncio
import json
import urllib.request
import urllib.parse
from os import getenv
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.core.signing import TimestampSigner, BadSignature, SignatureExpired
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


def webapp(request):
    signer = TimestampSigner()
    translate_token = signer.sign("translate_access")
    return render(request, "example/webapp.html", {"translate_token": translate_token})


@csrf_exempt
def translate_text(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Only POST method is allowed'}, status=405)

    token = request.headers.get('X-Translate-Token')
    if not token:
        return JsonResponse({'error': 'Unauthorized'}, status=403)

    signer = TimestampSigner()
    try:
        unsigned = signer.unsign(token, max_age=86400)
        if unsigned != "translate_access":
            return JsonResponse({'error': 'Invalid token'}, status=403)
    except (BadSignature, SignatureExpired):
        return JsonResponse({'error': 'Token expired or invalid'}, status=403)

    try:
        data = json.loads(request.body.decode('utf-8'))
        text = data.get('q', '')
        target_lang = data.get('target', 'en')

        if not text:
            return JsonResponse({'translatedText': ''})

        libretranslate_url = getenv("LIBRETRANSLATE_URL", "")

        urls_to_try = []
        if libretranslate_url:
            urls_to_try.append(libretranslate_url)
        else:
            urls_to_try = [
                "http://localhost:5000/translate",
                "https://translate.fedilab.app/translate"
            ]

        for url in urls_to_try:
            try:
                payload = json.dumps({
                    'q': text,
                    'source': 'auto',
                    'target': target_lang,
                    'format': 'text'
                }).encode('utf-8')

                req = urllib.request.Request(
                    url,
                    data=payload,
                    headers={
                        'Content-Type': 'application/json',
                        'User-Agent': 'TelegramBot/1.0'
                    }
                )

                with urllib.request.urlopen(req, timeout=4) as response:
                    res_data = json.loads(response.read().decode('utf-8'))
                    translated_text = res_data.get('translatedText')
                    if translated_text:
                        return JsonResponse({'translatedText': translated_text})
            except Exception as exc:
                print(f"Translation failed for {url}: {exc}")

        return JsonResponse({'translatedText': text})

    except Exception as exc:
        print("Translation handler error:", exc)

    return JsonResponse({'translatedText': text})




