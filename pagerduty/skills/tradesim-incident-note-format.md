# TradeSim incident note format

When you post your findings on a TradeSim incident, post ONE note in exactly this shape. The TradeSim UI panel reads it.

```
SRE Agent: <one-line root cause, plain language>
Panel summary: <at most 60 characters>

Evidence:
- <what you saw: alert, log line, metric, change event, with timestamps>
Impact:
- <which services and customer actions are affected>
Recommended fix:
- <the one action you recommend and why it is safe>
```

## Rules

- The first line must start with `SRE Agent:`. The UI only picks up notes that start that way, and uses the first one.
- The `Panel summary:` line is shown to a live audience as "Root cause found". Keep it at most 60 characters, one line,
  no markdown, no trailing punctuation. Name the cause, not the symptom.
  - Good: `Inverted buying-power check in risk v1.0.1`
  - Good: `DB pool cut to 1 connection by a config change`
  - Bad: `Multiple services are failing` (symptom, not cause)
- Post the note once you are confident of the root cause. Do not post a note that says you are still investigating.
- Do not include customer data, credentials or routing keys in a note.
