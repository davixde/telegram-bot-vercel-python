# example/urls.py
from django.urls import path

from example.views import index, webapp

urlpatterns = [
    path('', index),
    path('webapp/', webapp, name='webapp'),
]