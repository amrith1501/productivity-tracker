# Sample task imports

Drop these files into your `tasks_inbox/` (or point the **Import tasks from
a directory** form in the Supervisor dashboard at this folder) to see tasks
flow into the app.

## `sample_tasks.csv`

Demonstrates the CSV format the importer understands. Columns:

| Column                 | Required | Purpose                                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `Task ID`              | no       | A stable identifier from your spreadsheet (e.g. `T-001`). Stored on the task, shown in the UI, and used to make imports **idempotent**: a Task ID is imported at most once per supervisor, so re-importing the same row never creates a duplicate. |
| `Task Name`            | yes      | Title of the task. Aliases: `Title`, `Task`, `Name`.                                              |
| `Description`          | no       | Free-form notes shown to the worker.                                                              |
| `Assigned Employee_ID` | no       | Username **or** display name of a worker on your team. Blank = auto-distribute.                   |

### JSON format

JSON inbox files can carry the same Task ID via a `task_id` (or `id`) field:

```json
{
  "tasks": [
    {"task_id": "T-001", "title": "Review Q2 design doc", "description": "…"}
  ]
}
```

Rows/objects without a Task ID still work — they're imported every time the
file is processed (deduplication only applies when a Task ID is present).

### How assignment works after import

1. **Row has a valid `Assigned Employee_ID`** → the task goes straight to
   that worker.
2. **Row is blank** → the task is round-robin balanced across your team,
   so workload stays even.
3. **Row points at someone not on your team** → the row is still
   imported (auto-distributed) and a warning is surfaced in the import
   result panel.

Headers are matched case- and punctuation-insensitively, so
`assigned_employee_id`, `Assignee`, `Employee ID`, and `username` all
work.
