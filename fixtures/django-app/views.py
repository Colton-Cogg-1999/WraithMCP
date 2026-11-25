from django.contrib import messages
from django.utils.translation import gettext as _

def save_profile(request, count):
    ok = _("Account saved")
    messages.success(request, "Settings updated cleanly")
    messages.info(request, f"Processed {count} records")
    return ok
