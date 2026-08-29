# Privacy

mtdo can optionally record a small amount of local usage data to help improve the
app. This is **off by default** -- you're asked once, during first-run setup, and
your answer is never re-asked.

## What's collected (only if you turn it on)

Structural facts about how you use the app -- which screen or action, how often,
how long, whether something succeeded. For example: how many sessions you've had,
whether you opened Career CRM or the Knowledge Vault, how many Pomodoros you ran,
which AI backend (Claude Code / Ollama / an API chat) you used, whether a Practice
Lab run succeeded, and the *type* of an error shown to you (e.g. `ConfigError`),
never its message text.

Task status changes are recorded against a one-way hash of the task's date,
category, and position -- never the task's actual text, so what you're working on
is never recorded, only that *something* moved from one column to another and when.

## What's never collected, ever

- Task, goal, note, or curriculum text
- AI conversation content -- neither your prompts nor any reply
- Practice Lab source code, or its output/stdout/stderr
- Any file path (goals.json location, Knowledge Vault files, etc.)
- Category or profile display names
- Exception *message* text (only the exception's type name, e.g. `ConfigError`)
- Passwords, recovery codes, or API keys (already separately protected -- see
  `profiles.py`'s encryption design)

## Where it lives

Entirely on your own machine, at `~/.mtdo/events.db` (a plain sqlite3 file), plus a
random, anonymous `~/.mtdo/install_id` generated the first time you turn analytics
on. Nothing is sent anywhere over the network -- as of this version, there is no
remote collection endpoint at all.

You can inspect exactly what's stored at any time:

```
mtdo analytics status   # on/off, event count, date range
mtdo analytics show     # every stored event, as JSON
```

And delete it whenever you want:

```
mtdo analytics off      # stop recording (existing events untouched)
mtdo analytics purge    # permanently delete everything stored
```

Old events are also pruned automatically after 180 days.

## If mtdo ever adds remote/cross-install analytics

That would be a second, independent opt-in (`remote_enabled`, separate from local
`local_enabled`) -- turning on local recording would never by itself send anything
off your machine. Any such upload would be manually triggered, aggregate-only, and
this document would be updated to say exactly what's sent before that ships.
