# Wraith Domain Language

The shared vocabulary for talking about Wraith itself. Not to be confused with a project's **Term Base** (the translation glossary Wraith enforces).

## Language

**Term Base**:
The per-project list of approved translations and do-not-translate terms that Wraith enforces during checks.
_Avoid_: Glossary (ambiguous with this document), termbase file

**Context Note**:
A short plain-language statement of what a string means and where it appears, written for a translator (e.g. "Button that saves the open document — not about saving money").
_Avoid_: File context, snippet, comment

**Open Question**:
A string the agent could not confidently interpret from its surroundings, held until a human supplies the missing meaning.
_Avoid_: Escalation (that is a reviewer handoff of a finished translation), flag

**Answer**:
A human's resolution of an Open Question; it becomes durable context for that string on every later run.

**Assumption**:
An interpretation the agent chose on its own without asking (e.g. register, brand handling), reported so a human can overturn it.
_Avoid_: Default, guess

**Character Limit**:
The maximum length a translation of a string may have before it breaks its UI. Either **Declared** (stated by a human; binding) or **Inferred** (estimated by Wraith; advisory).
_Avoid_: Max length, size restriction

**Mitigation**:
A defect Wraith detected in a translation that was subsequently fixed within the same run.
_Avoid_: Fix, correction
