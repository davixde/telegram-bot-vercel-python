# example/urls.py
from django.urls import path

from telegram_bot.views import index, webapp

urlpatterns = [
    path('', index),
    path('webapp/', webapp, name='webapp'),
]