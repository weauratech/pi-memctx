# Persistence

`memctx_save` writes durable notes to the active pack. pi-memctx can also queue autosave candidates after meaningful turns when `/memctx-autosave` is enabled.

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
- Autosave candidates are stored in a local review queue before being approved, unless `auto` mode is enabled and confidence is high.

## Autosave and review

```txt
/memctx-autosave off|suggest|confirm|auto|status
/memctx-save-queue list|approve <id>|reject <id>|clear
```

`autosave=suggest` queues candidates and shows a widget. `autosave=auto` only writes directly when confidence is high; otherwise candidates remain reviewable.

## Limitations

Secret detection is defensive, not perfect. Review memory notes before publishing or sharing packs.
