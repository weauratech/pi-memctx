# Persistence

`memctx_save` writes durable notes to the active pack.

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

## Limitations

Secret detection is defensive, not perfect. Review memory notes before publishing or sharing packs.
