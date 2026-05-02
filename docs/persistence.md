# Persistence

`memctx_save` writes durable notes to the active pack. The gateway profile also runs a conservative post-turn memory curator by default: after each meaningful turn, pi-memctx looks for durable project knowledge, conventions, runbooks, architecture, business rules, completed actions, or explicit user/team preferences worth saving.

## Supported types

- `observation`: discovered fact about code, infra, behavior, or conventions.
- `decision`: durable technical or architectural decision with rationale.
- `action`: completed task or notable change.
- `runbook`: repeatable procedure.
- `context`: project, stack, or team context.

## Behavior

- Notes are Markdown files with frontmatter.
- Existing notes with the same slug are appended to instead of overwritten.
- Action notes include the current date in the filename.
- Index files are updated when a matching index exists.
- Common secret patterns are blocked before writing.
- High-confidence curator candidates are saved automatically in `auto` mode; lower-confidence candidates are queued locally for review.

## Autosave and review

```txt
/memctx-autosave off|suggest|confirm|auto|status
/memctx-save-queue list|approve <id>|reject <id>|clear
```

`autosave=suggest` queues candidates and shows a widget. `autosave=confirm` asks immediately. `autosave=auto` writes directly when confidence is high and queues lower-confidence candidates when `MEMCTX_AUTOSAVE_QUEUE_LOW_CONFIDENCE=true` (the gateway default).

## Limitations

Secret detection is defensive, not perfect. Review memory notes before publishing or sharing packs.
