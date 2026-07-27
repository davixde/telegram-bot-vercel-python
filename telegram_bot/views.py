import asyncio
import hashlib
import json
import os
import secrets
import urllib.request
import urllib.parse
from os import getenv
from django.http import HttpResponse, HttpResponseBadRequest, JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_exempt
from django.core.signing import TimestampSigner, BadSignature, SignatureExpired
from .bot import bot_tele

# ---------------------------------------------------------------------------
# OSM OAuth 2.0 PKCE constants – configure via environment variables
# ---------------------------------------------------------------------------
OSM_CLIENT_ID     = getenv("OSM_CLIENT_ID", "")
OSM_CLIENT_SECRET = getenv("OSM_CLIENT_SECRET", "")
OSM_REDIRECT_URI  = getenv("OSM_REDIRECT_URI", "")
OSM_AUTH_URL      = "https://www.openstreetmap.org/oauth2/authorize"
OSM_TOKEN_URL     = "https://www.openstreetmap.org/oauth2/token"
# Cookie name used to carry the PKCE code_verifier across the redirect
_OSM_VERIFIER_COOKIE = "osm_pkce_verifier"


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


# ---------------------------------------------------------------------------
# OSM OAuth 2.0 PKCE flow
# ---------------------------------------------------------------------------

def _pkce_pair():
    """Generate a random PKCE code_verifier and its SHA-256 code_challenge."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = urllib.parse.quote(
        # base64url without padding
        __import__('base64').urlsafe_b64encode(digest).rstrip(b'=').decode()
    )
    return verifier, challenge


def osm_oauth_start(request):
    """
    Step 1 of the OSM OAuth 2.0 PKCE flow.

    Generates a random state value and a PKCE code_verifier / code_challenge
    pair, stores them in a short-lived signed HttpOnly cookie alongside the
    caller's Telegram user ID, then redirects to the OSM authorization page.

    The Telegram user ID (tg_user_id) is passed as a GET param by the Mini App
    so that the callback can send a bot message back to the correct user.
    """
    if not OSM_CLIENT_ID or not OSM_REDIRECT_URI:
        return HttpResponseBadRequest(
            "OSM OAuth is not configured. Set OSM_CLIENT_ID and OSM_REDIRECT_URI."
        )

    # One-time random value to prevent CSRF on the callback
    state    = secrets.token_urlsafe(32)
    verifier, challenge = _pkce_pair()

    # Telegram user ID sent by the Mini App (used later to deliver the bot message)
    tg_user_id = request.GET.get("tg_user_id", "")

    # Build the OSM authorization URL
    params = urllib.parse.urlencode({
        "response_type":          "code",
        "client_id":              OSM_CLIENT_ID,
        "redirect_uri":           OSM_REDIRECT_URI,
        "scope":                  "read_prefs",
        "state":                  state,
        "code_challenge":         challenge,
        "code_challenge_method":  "S256",
    })
    auth_url = f"{OSM_AUTH_URL}?{params}"

    response = redirect(auth_url)

    # Persist state, verifier and user_id in a JSON payload inside a signed
    # HttpOnly cookie.  SameSite=None + Secure is required so the browser
    # sends the cookie back when OSM redirects to our callback (cross-site).
    signer = TimestampSigner()
    cookie_payload = json.dumps({
        "state":    state,
        "verifier": verifier,
        "user_id":  tg_user_id,
    })
    response.set_cookie(
        _OSM_VERIFIER_COOKIE,
        signer.sign(cookie_payload),
        max_age=600,      # 10 minutes – enough time for the user to log in
        httponly=True,
        secure=True,
        samesite="None",
    )
    return response


@csrf_exempt
def osm_oauth_callback(request):
    """
    Step 2 of the OSM OAuth 2.0 PKCE flow.

    OSM redirects here with ?code=...&state=... after the user grants access.
    We verify the state cookie, exchange the code for an access token, then
    use TWO parallel handoff strategies to get the token back into the Mini App:

      1. PRIMARY (all platforms): Send a Telegram bot message to the user with a
         WebApp button that opens the Mini App at WEBAPP_URL?osm_token=<token>.
         The Mini App reads the token from the URL query param on load.

      2. SECONDARY (same-browser / Telegram Web): The relay page writes the token
         into localStorage so the Mini App can pick it up via the 'storage' event
         in real time, without any user interaction.
    """
    code  = request.GET.get("code")
    state = request.GET.get("state")
    error = request.GET.get("error")

    # Surface OSM-side authorization errors to the relay page
    if error or not code or not state:
        reason = error or "missing_code_or_state"
        return render(request, "example/osm_callback.html", {"error": reason})

    # Retrieve and verify the signed PKCE cookie
    cookie_value = request.COOKIES.get(_OSM_VERIFIER_COOKIE)
    if not cookie_value:
        return render(request, "example/osm_callback.html",
                      {"error": "missing_verifier_cookie"})

    signer = TimestampSigner()
    try:
        unsigned = signer.unsign(cookie_value, max_age=600)
        # Cookie payload is a JSON object {state, verifier, user_id}
        cookie_data = json.loads(unsigned)
        stored_state = cookie_data["state"]
        verifier     = cookie_data["verifier"]
        tg_user_id   = cookie_data.get("user_id", "")
    except (BadSignature, SignatureExpired):
        return render(request, "example/osm_callback.html",
                      {"error": "invalid_or_expired_cookie"})
    except (json.JSONDecodeError, KeyError):
        return render(request, "example/osm_callback.html",
                      {"error": "malformed_cookie"})

    if stored_state != state:
        return render(request, "example/osm_callback.html",
                      {"error": "state_mismatch"})

    # Exchange the authorization code for an access token
    try:
        token_payload = urllib.parse.urlencode({
            "grant_type":    "authorization_code",
            "code":          code,
            "redirect_uri":  OSM_REDIRECT_URI,
            "client_id":     OSM_CLIENT_ID,
            "code_verifier": verifier,
        }).encode()

        headers = {"Content-Type": "application/x-www-form-urlencoded"}

        # Include client_secret only for confidential clients
        if OSM_CLIENT_SECRET:
            import base64 as _b64
            credentials = _b64.b64encode(
                f"{OSM_CLIENT_ID}:{OSM_CLIENT_SECRET}".encode()
            ).decode()
            headers["Authorization"] = f"Basic {credentials}"

        req = urllib.request.Request(
            OSM_TOKEN_URL,
            data=token_payload,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            token_data = json.loads(resp.read().decode())
    except Exception as exc:
        print("OSM token exchange error:", exc)
        return render(request, "example/osm_callback.html",
                      {"error": "token_exchange_failed"})

    access_token = token_data.get("access_token")
    if not access_token:
        return render(request, "example/osm_callback.html",
                      {"error": "no_access_token"})

    # Build the Mini App return URL – the token travels as a query param.
    # The Mini App reads it, saves it to localStorage, then immediately strips
    # it from the URL via history.replaceState to minimise exposure.
    webapp_url = getenv("WEBAPP_URL", "").rstrip("/")
    if not webapp_url:
        webapp_url = request.build_absolute_uri("/webapp")
    osm_return_url = f"{webapp_url}?osm_token={urllib.parse.quote(access_token, safe='')}"

    # Determine the allowed origin for the relay-page postMessage fallback
    from urllib.parse import urlparse as _urlparse
    parsed        = _urlparse(webapp_url)
    allowed_origin = f"{parsed.scheme}://{parsed.netloc}"

    # ------------------------------------------------------------------
    # PRIMARY HANDOFF: send a Telegram bot message with a WebApp button.
    # This works universally on mobile and desktop regardless of the
    # browser used for the OAuth flow.
    # ------------------------------------------------------------------
    bot_message_sent = False
    bot_token        = getenv("TOKEN", "")
    if tg_user_id and bot_token:
        try:
            msg_body = json.dumps({
                "chat_id": int(tg_user_id),
                "text": (
                    "\u2705 <b>OpenStreetMap account connected!</b>\n\n"
                    "Tap the button below to return to the Piano Map."
                ),
                "parse_mode": "HTML",
                "reply_markup": json.dumps({
                    "inline_keyboard": [[
                        {
                            "text": "\U0001f3b9 Return to Piano Map",
                            "web_app": {"url": osm_return_url},
                        }
                    ]]
                }),
            }).encode()

            bot_req = urllib.request.Request(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                data=msg_body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(bot_req, timeout=8) as bot_resp:
                result = json.loads(bot_resp.read().decode())
                bot_message_sent = result.get("ok", False)
        except Exception as exc:
            print("OSM bot sendMessage error:", exc)

    context = {
        "access_token":    access_token,
        "allowed_origin":  allowed_origin,
        "bot_message_sent": bot_message_sent,
        "osm_return_url":  osm_return_url,
    }
    response = render(request, "example/osm_callback.html", context)
    response.delete_cookie(_OSM_VERIFIER_COOKIE)
    return response
