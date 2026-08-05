# telegram_bot/urls.py
from django.urls import path

from telegram_bot.views import (
    index,
    webapp,
    translate_text,
    still_here,
    osm_oauth_start,
    osm_oauth_callback,
)

urlpatterns = [
    path('', index),
    path('webapp/', webapp, name='webapp'),
    path('api/translate/', translate_text, name='translate_text'),
    path('api/still-here/', still_here, name='still_here'),
    # OSM OAuth 2.0 PKCE endpoints
    path('api/osm/start/', osm_oauth_start, name='osm_oauth_start'),
    path('api/osm/callback/', osm_oauth_callback, name='osm_oauth_callback'),
]