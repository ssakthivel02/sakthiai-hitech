# Database Recovery Readiness — Controlled Preview

This document defines the repository-level evidence required before a controlled-preview database migration or restore can be represented as ready.

## Scope

This lane does not execute a migration, create a backup, restore a database, inspect secrets, or mutate the managed preview database. It encodes the evidence contract that an operator must satisfy before making those claims.

## Required before migration

- exact candidate commit recorded;
- exact expected database name confirmed;
- verified TLS/CA path confirmed;
- fresh pre-migration backup created;
- backup identifier and creation time recorded;
- backup integrity evidence recorded;
- migration command and migration compatibility assessment recorded;
- explicit approval for any destructive migration.

## Required before restore can be called verified

- restore target explicitly identified;
- restore procedure recorded;
- backup selected by immutable identifier rather than "latest";
- restored database identity checked;
- application readiness checked after restore;
- evidence retained for the exact candidate/recovery event.

## Fail-closed rules

Automatic production restore is not authorised. Missing backup evidence, unknown database identity, unverified TLS, missing restore verification, or absent owner approval is a NO-GO.

## Evidence boundary

Passing the repository validator proves only that the recovery policy is encoded and internally consistent. It does not prove that a live Aiven backup exists, that `db:push` has run, that a restore has succeeded, or that the deployed preview is ready. Those require approved runtime operations and real evidence outside Git.
