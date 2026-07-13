# Acme Control Plane

## Purpose

This repository is the live Acme content and presence control plane worker.

It is intentionally separate from:

- [BDN-control-plane](C:/BeaconSignageCore/BDN-control-plane/README.md)
- the tenant auth/routing worker
- the tenant client portal

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

## Scope

This worker currently owns the Acme live content plane for:

- heartbeat ingest and live presence reads
- region and device settings reads/writes
- playlist and manifest publish flows
- primary and footer asset upload helpers
- region live state fan-out
- public asset serving for uploaded footer files

It is deliberately not the auth boundary. Operator identity and tenant-scoped session handling are handled by the separate tenant control-plane worker.

## Primary Documents

- [BDN-TENANT-CONTROL-PLANE-ARCHITECTURE.md](C:/BeaconSignageCore/acme-control-plane/BDN-TENANT-CONTROL-PLANE-ARCHITECTURE.md)
- [schema.sql](C:/BeaconSignageCore/acme-control-plane/schema.sql)
- [wrangler.jsonc](C:/BeaconSignageCore/acme-control-plane/wrangler.jsonc)

## Current Status

This worker is deployed and in active use by the Acme tenant portal and Acme signage fleet.

Current live capabilities include:

- tenant-aware heartbeat ingest
- tenant-aware settings read/write routes
- tenant-aware websocket fan-out
- tenant, region, and device inventory routes
- tenant-region Durable Object live state
- primary asset and footer asset support for the portal

Current architecture split:

- `acme-control-plane`
  owns live content, manifests, assets, and presence
- `bdn-tenant-control-plane`
  owns user identity, routing admin, and tenant-scoped auth decisions

## Deployment Notes

- this worker is deployed manually with Wrangler
- GitHub push does not by itself publish this worker
- keep CORS/auth origin settings aligned with the Pages portal URL in [wrangler.jsonc](C:/BeaconSignageCore/acme-control-plane/wrangler.jsonc)
