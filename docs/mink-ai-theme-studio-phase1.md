# Mink AI Theme Studio — Phase 1 implementation record

> **Status:** implemented on 2026-09-23. This phase adds the runtime theme
> registry and migrates theme resolution; it does not add the operator Studio
> shell, generation, uploads, approval, or publication UI.

## Outcome

StoreMink can now resolve an immutable, database-backed theme release without
an application deploy. Existing bundled releases remain the fallback, so an
empty, unavailable, or invalid runtime registry cannot remove the four themes
that already ship with the application.

## Persistence contract

Migration `20260923_0127_theme_runtime_registry` adds two service-owned tables:

- `theme_releases` stores one immutable, validated `ThemePackageV2` for each
  `(theme_id, version)`, its SHA-256 content digest, release status, source,
  creator, and creation time.
- `theme_catalog_entries` stores the mutable current-release pointer and
  catalog visibility for each theme id.

The split is intentional. A store pins `theme_id` and semantic version, so
moving or restoring the catalog pointer affects only new selection. It never
changes an existing installation. PostgreSQL triggers refuse release updates
and deletes and refuse catalog pointers to anything except a published release.
Both tables have RLS enabled, grant no access to `app_user`, and are accessed
only through the service role from server-only repository code.

## Resolution order

`lib/themes/runtime-registry.ts` validates database JSON with the Phase 0
contract and verifies its content digest before returning it.

For an exact installed pin, resolution is:

1. the matching published database release;
2. the matching bundled immutable release;
3. that bundled theme's current release; and
4. the platform default bundled theme.

For an unversioned selection, resolution is:

1. the database catalog pointer, including a hidden pointer needed by an
   already-installed legacy store;
2. the bundled current release; and
3. the platform default.

The public catalog overlays valid runtime pointers onto bundled metadata and
then applies visibility rules. Invalid packages, mismatched ids or versions,
non-published public pointers, and digest mismatches fail closed to bundled
data. Candidate lookup is exact and never substitutes another release.

Reads are cached for five minutes under `theme-runtime-registry` and can be
invalidated after an import or pointer change. Server actions and standalone
scripts fall back to an uncached read when no Next render-cache scope exists.

## Migrated consumers

Runtime-aware resolution now feeds:

- the storefront visual design and layout variants;
- the public theme catalog;
- the signup picker and authoritative signup action;
- theme application and demo-store seeding;
- the operator theme/demo panel;
- Website Builder theme defaults and publish-time contrast validation; and
- Mink's existing storefront design readers and proposal checks.

The signup client receives only the serializable `ThemeMeta` projection from a
server layout. Full packages remain server-only.

## Import and restore command

Inspect bundled releases without writing:

```bash
npm run theme-registry:import
```

Idempotently import bundled releases and create only missing catalog pointers:

```bash
npm run theme-registry:import -- --commit
```

Explicitly select or restore a published release for new installs:

```bash
npm run theme-registry:import -- --activate studio@0.1.0 --visibility public
```

Production writes additionally require `--confirm-production storemink`. The
command refuses immutable id/version collisions whose digests differ and never
advances an existing catalog pointer during a routine import. Because a
standalone script has no access to a running Next cache, an activation made by
the command can take up to the registry's five-minute cache window to appear;
future in-app publication invalidates the tag immediately.

## Deferred to later phases

- Phase 2 adds the superadmin Studio routes, projects, secure intake, messages,
  runs, versions, and audit events.
- Phase 3 adds the dedicated Vertex/Anthropic generation pipeline.
- Phase 4 adds full-fidelity responsive candidate previews and revision UI.
- Phase 6 adds the reviewed publication orchestration and publication-event
  audit trail.

## Help Centre decision

This is internal registry infrastructure. It changes no merchant, staff, or
shopper task, so there is no Help Centre migration.
