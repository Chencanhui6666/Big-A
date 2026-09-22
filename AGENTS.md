# Big A data publication workflow

For a successful Big A real-data routine, after all provider, archive, simulation, and dashboard validation gates pass, commit the data update before returning the result.

- Stage only the verified routine artifacts: `provider-data/longbridge-latest.json`, `public/data/latest/`, `public/data/manifest.json`, `public/data/index.json`, and the new `public/data/snapshots/YYYY-MM-DD/HH-mm-ss/` archive. Include pipeline or strategy source only when that source was intentionally changed as part of the same task.
- Inspect the staged diff before committing. Do not stage unrelated, pre-existing, or unvalidated changes.
- Use one descriptive commit that identifies the Longbridge CN trade date, then push the current branch to its configured remote.
- If staging, committing, or pushing fails, leave the validated published batch intact and report the exact Git failure. Do not retry a permission, authorization, or malformed-data failure.
