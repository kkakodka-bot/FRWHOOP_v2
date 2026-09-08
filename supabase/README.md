# FRWHOOP schema migrations

Canonical lineage: **this directory** (`supabase/migrations/`).

From the repository root:

```text
supabase db start
supabase db reset --yes
```

`SUPABASE_INTERNAL_IMAGE_REGISTRY=public.ecr.aws` is required on some hosts
(and in CI). `make supabase-reset` wraps the same commands.

`history/` is archival SQL, not an apply root. Do not apply it.

Link a hosted project only when you need `db push`:

```text
supabase link --project-ref <your-project-ref>
```

The project ref is stored in gitignored `supabase/.temp/`. Never reset a
production database.
