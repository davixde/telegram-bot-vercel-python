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
# The callback relay page inlines the OSM access token – it must never be
# cached by the browser or by an intermediary (CDN / proxy), otherwise a
# stale page (old token, or an error from a previous attempt) could be
# served on a later callback.
_NOCACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma":        "no-cache",
    "Expires":       "0",
}
# How many parallel OAuth flows we keep in the verifier cookie.
_MAX_PENDING_FLOWS = 5


def _read_pending_flows(cookie_value):
    """Parse the signed PKCE cookie into a list of pending OAuth flows.

    Returns a list of dicts with keys {state, verifier, user_id}. Empty list
    when the cookie is missing, expired, tampered with, or holds no usable
    flows. For backwards compatibility a legacy single-flow payload (a dict)
    is wrapped into a one-element list.
    """
    if not cookie_value:
        return []
    signer = TimestampSigner()
    try:
        unsigned = signer.unsign(cookie_value, max_age=600)
        data = json.loads(unsigned)
    except (BadSignature, SignatureExpired, json.JSONDecodeError):
        return []
    if isinstance(data, list):
        return [f for f in data if isinstance(f, dict) and f.get("state")]
    if isinstance(data, dict) and data.get("state"):
        return [data]
    return []


def _render_callback(request, context):
    """Render the OSM callback relay page with cache-busting headers."""
    response = render(request, "example/osm_callback.html", context)
    for header, value in _NOCACHE_HEADERS.items():
        response[header] = value
    return response


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
            return JsonResponse({'translatedText': '', 'detectedLanguage': None})

        # 1) Google Translate free endpoint – no key, also returns detected language
        try:
            google_url = "https://translate.googleapis.com/translate_a/single?" + urllib.parse.urlencode({
                'client': 'gtx',
                'sl': 'auto',
                'tl': target_lang,
                'dt': 't',
                'q': text
            })
            req = urllib.request.Request(google_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as response:
                res_data = json.loads(response.read().decode('utf-8'))

            translated_text = ''.join(seg[0] for seg in res_data[0] if seg and seg[0])
            detected_lang = res_data[2] if len(res_data) > 2 and isinstance(res_data[2], str) and res_data[2] else None
            if translated_text:
                return JsonResponse({'translatedText': translated_text, 'detectedLanguage': detected_lang})
        except Exception as exc:
            print(f"Google Translate failed: {exc}")

        # 2) MyMemory free fallback – no key, limited quota (also returns detected language)
        try:
            mm_url = "https://api.mymemory.translated.net/get?" + urllib.parse.urlencode({
                'q': text,
                'langpair': f'autodetect|{target_lang}'
            })
            req = urllib.request.Request(mm_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as response:
                res_data = json.loads(response.read().decode('utf-8'))

            translated_text = res_data.get('responseData', {}).get('translatedText')
            if (res_data.get('responseStatus') == 200
                    and not res_data.get('quotaFinished')
                    and translated_text):
                detected_lang = res_data.get('responseData', {}).get('detectedLanguage')
                return JsonResponse({'translatedText': translated_text, 'detectedLanguage': detected_lang})
        except Exception as exc:
            print(f"MyMemory failed: {exc}")

        # All providers failed – return the text untranslated
        return JsonResponse({'translatedText': text, 'detectedLanguage': None})

    except Exception as exc:
        print("Translation handler error:", exc)

    return JsonResponse({'translatedText': text, 'detectedLanguage': None})


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
        "scope":                  "read_prefs write_api",
        "state":                  state,
        "code_challenge":         challenge,
        "code_challenge_method":  "S256",
    })
    auth_url = f"{OSM_AUTH_URL}?{params}"

    response = redirect(auth_url)

    # Persist state, verifier and user_id in a signed HttpOnly cookie.
    # SameSite=None + Secure is required so the browser sends the cookie
    # back when OSM redirects to our callback (cross-site).
    #
    # The cookie holds a LIST of in-flight flows (instead of a single
    # object) so starting a second login while one is still pending – a
    # retry, or the same account from a different browser/device – does not
    # clobber the first flow's verifier (which would fail its callback with
    # a state mismatch). Each callback consumes only its own state entry.
    signer = TimestampSigner()
    flows = _read_pending_flows(request.COOKIES.get(_OSM_VERIFIER_COOKIE))
    flows.append({
        "state":    state,
        "verifier": verifier,
        "user_id":  tg_user_id,
    })
    # Keep only the most recent flows so the cookie stays small.
    flows = flows[-_MAX_PENDING_FLOWS:]
    response.set_cookie(
        _OSM_VERIFIER_COOKIE,
        signer.sign(json.dumps(flows)),
        max_age=600,      # 10 minutes – enough time for the user to log in
        httponly=True,
        secure=True,
        samesite="None",
    )
    # Never cache the redirect chain: the eventual relay page embeds a token.
    for header, value in _NOCACHE_HEADERS.items():
        response[header] = value
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
        return _render_callback(request, {"error": reason})

    # Retrieve and verify the signed PKCE cookie (holds a list of flows)
    cookie_value = request.COOKIES.get(_OSM_VERIFIER_COOKIE)
    if not cookie_value:
        return _render_callback(request, {"error": "missing_verifier_cookie"})

    flows = _read_pending_flows(cookie_value)
    if not flows:
        return _render_callback(request, {"error": "invalid_or_expired_cookie"})

    # Find the flow that matches THIS callback's state. Other in-flight flows
    # (from parallel/retried logins) are left untouched in the cookie.
    matching = [f for f in flows if f.get("state") == state]
    if not matching:
        return _render_callback(request, {"error": "state_mismatch"})

    flow = matching[0]
    verifier   = flow.get("verifier")
    tg_user_id = flow.get("user_id", "")

    if not verifier:
        return _render_callback(request, {"error": "malformed_cookie"})

    # Consume this flow: its code_verifier must not be reusable.
    flows = [f for f in flows if f.get("state") != state]

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
        return _render_callback(request, {"error": "token_exchange_failed"})

    access_token = token_data.get("access_token")
    if not access_token:
        return _render_callback(request, {"error": "no_access_token"})

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
    # PRIMARY HANDOFF: send a Telegram bot message to the user.
    #
    # We use sendPhoto with a banner image and a ReplyKeyboardMarkup that
    # shows a WebApp keyboard button (the keyboard suggestion bar below the
    # chat input). The user taps it to re-open the Mini App with the token
    # already in the URL – no inline button attached to the message.
    #
    # Falls back to a plain sendMessage if the banner image is unavailable.
    # ------------------------------------------------------------------
    bot_message_sent = False
    bot_token        = getenv("TOKEN", "")

    # Reply keyboard: a single WebApp button shown in the suggestion bar.
    # one_time_keyboard hides it after the user taps it.
    reply_keyboard = json.dumps({
        "keyboard": [[{
            "text":    "\U0001f3b9 Return to Piano Map",
            "web_app": {"url": osm_return_url},
        }]],
        "resize_keyboard":   True,
        "one_time_keyboard": True,
    })

    # Banner served from the project's static files.
    # Place your image at:  telegram_bot/static/example/assets/osm_banner.png
    banner_url = f"{allowed_origin}/static/example/assets/osm_banner.png"

    caption = (
        "🎉 <b>OpenStreetMap Account Connected!</b>\n\n"
        "⚠️ <b>One last step:</b> Tap the button below to complete the setup."
    )

    if tg_user_id and bot_token:
        # Try sendPhoto first (banner + caption + reply keyboard)
        try:
            photo_body = json.dumps({
                "chat_id":      int(tg_user_id),
                "photo":        banner_url,
                "caption":      caption,
                "parse_mode":   "HTML",
                "reply_markup": reply_keyboard,
            }).encode()

            photo_req = urllib.request.Request(
                f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                data=photo_body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(photo_req, timeout=8) as r:
                result = json.loads(r.read().decode())
                bot_message_sent = result.get("ok", False)
        except Exception as exc:
            print("OSM bot sendPhoto error:", exc)

        # Fallback to plain text if sendPhoto failed
        if not bot_message_sent:
            try:
                text_body = json.dumps({
                    "chat_id":      int(tg_user_id),
                    "text":         caption,
                    "parse_mode":   "HTML",
                    "reply_markup": reply_keyboard,
                }).encode()

                text_req = urllib.request.Request(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    data=text_body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(text_req, timeout=8) as r:
                    result = json.loads(r.read().decode())
                    bot_message_sent = result.get("ok", False)
            except Exception as exc:
                print("OSM bot sendMessage error:", exc)


    context = {
        "access_token":    access_token,
        "allowed_origin":  allowed_origin,
        "bot_message_sent": bot_message_sent,
        "osm_return_url":  osm_return_url,
    }
    response = _render_callback(request, context)
    signer = TimestampSigner()
    if flows:
        # Other flows are still pending – keep them in the cookie.
        response.set_cookie(
            _OSM_VERIFIER_COOKIE,
            signer.sign(json.dumps(flows)),
            max_age=600,
            httponly=True,
            secure=True,
            samesite="None",
        )
    else:
        response.delete_cookie(_OSM_VERIFIER_COOKIE)
    return response
