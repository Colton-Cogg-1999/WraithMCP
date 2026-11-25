from django.utils.translation import gettext as _, ngettext

def status_view(request, count):
    # Clinic walk-in status ("Open" means open for business)
    clinic_status = _("Open")
    workspace_msg = _("Select a Workspace to view patient Invoices.")
    assigned = _("Assigned %(doctor)s for %(patient)s.") % {"doctor": "Dr. Lee", "patient": "Sam"}
    empty = _("No upcoming laboratory results are available yet.")
    rem = ngettext("%(count)d appointment remaining", "%(count)d appointments remaining", count) % {"count": count}
    return [clinic_status, workspace_msg, assigned, empty, rem]
