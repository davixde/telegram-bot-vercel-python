import asyncio
import datetime
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
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
    still_here_token = signer.sign("still_here_access")
    return render(request, "example/webapp.html", {
        "translate_token": translate_token,
        "still_here_token": still_here_token,
    })


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


# ---------------------------------------------------------------------------
# Still here – survey:date confirmation
# ---------------------------------------------------------------------------
# The "Still here" button confirms a piano is still present. Instead of making
# the user log in with their own OSM account, the update is performed here on
# the server using the bot's OWN OpenStreetMap account, whose OAuth2 access
# token is read from the OSM_BOT_ACCESS_TOKEN environment variable.
_OSM_API_BASE = "https://api.openstreetmap.org/api/0.6"


# ---------------------------------------------------------------------------
# Telegram WebApp initData validation
# ---------------------------------------------------------------------------
# The Mini App calls /api/still-here/ straight from the client, so any secret
# embedded in the page would be public (this is why the signed page token is
# NOT enough on its own). Instead we authenticate the caller via Telegram's
# initData: Telegram signs it with the bot token, so only a real user who
# opened the Mini App can produce a valid value.
_INIT_DATA_MAX_AGE = 86400  # seconds – how old initData may be (same as the
                             # signed page-token lifetime, so a user who keeps
                             # the app open all day is not locked out)


def _init_data_secret_key(bot_token):
    """Telegram: secret_key = HMAC_SHA256(message=bot_token, key="WebAppData")."""
    return hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()


def _valid_init_data(init_data, bot_token):
    """Return True when initData carries a valid Telegram signature and a fresh
    auth_date. Returns False for any missing, malformed, forged or expired
    value, and also when the bot token is not configured."""
    if not init_data or not bot_token:
        return False
    try:
        params = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
    except ValueError:
        return False

    received_hash = params.pop("hash", None)
    if not received_hash:
        return False

    # data_check_string: all fields except hash, sorted by key, k=v joined by \n
    # (values URL-decoded by parse_qsl, mirroring Telegram's official JS example)
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
    expected_hash = hmac.new(
        _init_data_secret_key(bot_token),
        data_check_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected_hash, received_hash):
        return False

    try:
        auth_date = int(params.get("auth_date", ""))
    except (TypeError, ValueError):
        return False
    # Reject both stale AND (clock-skewed) future auth dates.
    return 0 <= (time.time() - auth_date) <= _INIT_DATA_MAX_AGE


def _init_data_user_id(init_data):
    """Best-effort extraction of the Telegram user id from initData's `user`
    JSON field (used for rate limiting + audit). Returns None when absent."""
    if not init_data:
        return None
    try:
        params = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        return json.loads(params.get("user", "")).get("id")
    except (ValueError, TypeError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# Best-effort per-user rate limit for OSM writes
# ---------------------------------------------------------------------------
# The still-here endpoint writes to OSM with bot=yes, so it should not be
# spammable. On serverless (Vercel) memory is per warm instance and ephemeral,
# so this only counts requests hitting the same instance – imperfect but free,
# and it never blocks legitimate users (different instances can't collide on a
# user's bucket).
_RATE_LIMIT_MAX = 10      # still-here confirmations per user
_RATE_LIMIT_WINDOW = 3600 # per rolling hour
_rate_limit_buckets = {}  # tg user id -> [timestamps]


def _rate_limited(tg_user_id):
    """Return True when the user already used up their quota in the window."""
    if tg_user_id is None:
        return False
    now = time.time()
    cutoff = now - _RATE_LIMIT_WINDOW
    stamps = [t for t in _rate_limit_buckets.get(tg_user_id, []) if t > cutoff]
    if len(stamps) >= _RATE_LIMIT_MAX:
        _rate_limit_buckets[tg_user_id] = stamps
        return True
    stamps.append(now)
    _rate_limit_buckets[tg_user_id] = stamps
    return False


def _osm_api_request(path, method="GET", body=None, token=None):
    headers = {"User-Agent": "osm-public-pianos-bot"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/xml"
    req = urllib.request.Request(
        f"{_OSM_API_BASE}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8")


def _haversine_m(lat1, lon1, lat2, lon2):
    import math
    R = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _update_survey_date(elem_type, elem_id, bot_token, user_lat=None, user_lon=None):
    """Set the survey:date tag of an OSM element to today, preserving every
    other tag (and node refs for ways). Returns (version, already_confirmed),
    where already_confirmed is True when survey:date was already today and no
    write was needed (no changeset, no version churn)."""
    today = datetime.date.today().isoformat()

    # 1) Fetch the current element – the update must carry its version and
    #    keep all tags the confirmation does not touch.
    xml_text = _osm_api_request(f"/{elem_type}/{elem_id}", token=bot_token)
    root = ET.fromstring(xml_text)
    el = root.find(elem_type)
    if el is None:
        raise RuntimeError(f"Could not parse {elem_type} {elem_id} from OSM")
    if not el.get("version"):
        raise RuntimeError("Element has no version")

    # Only pianos may be confirmed: refuse to touch survey:date on an element
    # that is not tagged amenity=piano.
    el_tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
    if el_tags.get("amenity") != "piano":
        raise PermissionError("This element is not a piano (amenity=piano).")

    # Already confirmed today? Nothing to write – skip the changeset and the
    # PUT entirely (no useless OSM version churn).
    if el_tags.get("survey:date") == today:
        return el.get("version"), True

    # Defense in depth: the client already checks proximity, but the signed
    # token is effectively public, so enforce the 150 m rule server-side too
    # (nodes expose their coordinates; ways have none).
    if elem_type == "node" and user_lat is not None and user_lon is not None:
        try:
            nlat = float(el.get("lat"))
            nlon = float(el.get("lon"))
        except (TypeError, ValueError):
            nlat = nlon = None
        if nlat is not None and _haversine_m(user_lat, user_lon, nlat, nlon) > 150:
            raise PermissionError(
                "You are too far away from this piano to confirm its presence."
            )

    # 2) Open a changeset. bot=yes marks this as an automated edit (OSM
    #    automated edits code of conduct), created_by names the tool.
    cs_body = (
        "<osm><changeset>"
        '<tag k="created_by" v="Public Piano map"/>'
        '<tag k="bot" v="yes"/>'
        '<tag k="comment" v="Survey date update (Still here)"/>'
        "</changeset></osm>"
    )
    changeset_id = _osm_api_request(
        "/changeset/create", method="PUT", body=cs_body.encode(), token=bot_token
    ).strip()

    try:
        # 3) Update / add survey:date. Every other tag (including check_date,
        #    which StreetComplete may have set) is left untouched.
        found = None
        for tag in list(el):
            if tag.tag != "tag":
                continue
            if tag.get("k") == "survey:date":
                tag.set("v", today)
                found = tag
        if found is None:
            ET.SubElement(el, "tag", {"k": "survey:date", "v": today})

        el.set("changeset", changeset_id)
        # Strip metadata attributes the API ignores on write
        for attr in ("visible", "timestamp", "user", "uid"):
            el.attrib.pop(attr, None)

        payload = ("<osm>" + ET.tostring(el, encoding="unicode") + "</osm>").encode()

        # 4) PUT the updated element
        return (
            _osm_api_request(
                f"/{elem_type}/{elem_id}", method="PUT", body=payload, token=bot_token
            ).strip(),
            False,
        )
    finally:
        # 5) Always close the changeset (even when the PUT failed)
        try:
            _osm_api_request(
                f"/changeset/{changeset_id}/close", method="PUT", token=bot_token
            )
        except Exception:
            pass


@csrf_exempt
def still_here(request):
    """POST /api/still-here/ with {node_id, osm_type} – updates the element's
    survey:date to today using the bot's own OSM account."""
    if request.method != 'POST':
        return JsonResponse({'error': 'Only POST method is allowed'}, status=405)

    # The page token alone is public (it is embedded in the webapp HTML), so
    # the real gate is Telegram initData, which only a genuine Mini App user
    # can produce. The signed token stays as a cheap second layer.
    # The initData check is skipped when the bot token is not configured
    # (e.g. local dev without env vars) to keep local testing working.
    bot_token = getenv("TOKEN", "")
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    if bot_token and not _valid_init_data(init_data, bot_token):
        return JsonResponse({'error': 'Unauthorized'}, status=403)

    # Throttle writes per Telegram user (only possible once initData is valid,
    # so the user id cannot be forged).
    tg_user_id = _init_data_user_id(init_data)
    if _rate_limited(tg_user_id):
        return JsonResponse(
            {'error': 'Too many confirmations. Please try again later.'},
            status=429,
        )

    # Guarded by the signed-token pattern so
    # unauthenticated callers cannot spam OSM writes.
    token = request.headers.get('X-Still-Here-Token')
    if not token:
        return JsonResponse({'error': 'Unauthorized'}, status=403)
    signer = TimestampSigner()
    try:
        unsigned = signer.unsign(token, max_age=86400)
        if unsigned != "still_here_access":
            return JsonResponse({'error': 'Invalid token'}, status=403)
    except (BadSignature, SignatureExpired):
        return JsonResponse({'error': 'Token expired or invalid'}, status=403)

    bot_osm_token = getenv("OSM_BOT_ACCESS_TOKEN", "")
    if not bot_osm_token:
        return JsonResponse(
            {'error': 'Still-here updates are not configured (set OSM_BOT_ACCESS_TOKEN).'},
            status=500,
        )

    try:
        data = json.loads(request.body.decode('utf-8'))
    except (ValueError, TypeError):
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    elem_type = data.get('osm_type') or 'node'
    if elem_type not in ('node', 'way'):
        elem_type = 'node'
    try:
        elem_id = int(data.get('node_id'))
    except (TypeError, ValueError):
        return JsonResponse({'error': 'Missing or invalid node_id'}, status=400)

    def _as_float(value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    user_lat = _as_float(data.get('lat'))
    user_lon = _as_float(data.get('lon'))

    try:
        new_version, already = _update_survey_date(
            elem_type, elem_id, bot_osm_token, user_lat, user_lon
        )
    except PermissionError as exc:
        return JsonResponse({'error': str(exc)}, status=403)
    except Exception as exc:
        print("still_here update error:", exc)
        return JsonResponse(
            {'error': f'OpenStreetMap update failed: {exc}'},
            status=502,
        )

    print(f"still_here: tg user {tg_user_id} confirmed {elem_type} {elem_id}")
    return JsonResponse({
        'ok': True,
        'version': new_version,
        'date': datetime.date.today().isoformat(),
        'already': already,
    })
