# Acme Control Plane

## Purpose

This repository is the tenant-specific production control plane for Acme Signage.

It is intentionally separate from:

- [BDN-control-plane](C:/BeaconSignageCore/BDN-control-plane/README.md)

The older control plane remains the demo/proof-of-concept reference.

This repo is the production path for the Acme tenant and its region/device fleet:

- tenant: `acme`
- regions: `reg01` through `reg50`
- devices per region: `25`

## Identity Model

This control plane is built around:

- `tenant + region + device_id`

Example:

- `acme / reg01 / nuc-001`
- `brighton / reg01 / nuc-001`

Those must remain separate everywhere in routing, storage, scopes, and live region state.

## Wave 1 Scope

Wave 1 covers:

- tenant-aware identity
- tenant-aware sync scopes
- tenant-aware Durable Object naming
- tenant-aware D1 schema
- tenant-first API route shape

It does not yet include:

- full multi-tenant admin UI
- tenant-scoped operator auth
- deployment automation

## Primary Documents

- [BDN-TENANT-CONTROL-PLANE-ARCHITECTURE.md](C:/BeaconSignageCore/acme-control-plane/BDN-TENANT-CONTROL-PLANE-ARCHITECTURE.md)
- [schema.sql](C:/BeaconSignageCore/acme-control-plane/schema.sql)
- [wrangler.jsonc](C:/BeaconSignageCore/acme-control-plane/wrangler.jsonc)

## Current Status

This repo now contains the Wave 1 tenant-aware backend baseline:

- tenant-aware heartbeat ingest
- tenant-aware settings read/write routes
- tenant-aware websocket fan-out
- tenant, region, and device inventory routes
- tenant-region Durable Object live state

It is still not deployed yet.
