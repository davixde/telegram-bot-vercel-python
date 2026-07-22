# telegram_bot/urls.py
from django.urls import path

from telegram_bot.views import index, webapp, translate_text

urlpatterns = [
    path('', index),
    path('webapp/', webapp, name='webapp'),
    path('api/translate/', translate_text, name='translate_text'),
]