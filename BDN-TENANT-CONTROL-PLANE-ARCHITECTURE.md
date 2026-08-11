# BDN Tenant Control Plane Architecture

## Purpose

This document defines the production tenant-first backend architecture for future Beacon Digital Network customer deployments.

The older `BDN-control-plane` remains a demo/reference backend and should not be extended into the unrelated-customer production path.

## Core Identity

The production identity model is:

- `tenant + region + device_id`

All live state, settings scopes, device registry keys, and admin queries must use this identity.

## Tenant Rules

Tenant values should be stable slugs such as:

- `acme`
- `northshore`
- `brighton`

Do not use display names with spaces as primary keys.

## Region Rules

Region values remain:

- `reg01` through `reg99`

Regions are unique only within a tenant.

## Device Rules

Device IDs remain:

- `nuc-001`
- `nuc-002`
- `nuc-003`

Device numbers are unique only within a tenant region.

## Frontend Contract

Every screen should launch with:

- `?tenant=<tenant>&region=<region>&device=<device>`

Example:

- `/?tenant=acme&region=reg01&device=nuc-001`

## Scope Format

Region-scoped zones:

- `bdn:v1:tenant:acme:region:reg01:zone:primary`
- `bdn:v1:tenant:acme:region:reg01:zone:secondary`
- `bdn:v1:tenant:acme:region:reg01:zone:trivia`
- `bdn:v1:tenant:acme:region:reg01:zone:footer`

Legacy device-scoped weather remains accepted during migration:

- `bdn:v1:tenant:acme:device:reg01:nuc-001:zone:secondary`

## Durable Object Model

### TenantRegionDO

Live state object key:

- `tenant:<tenant>:region:<region>`

Example:

- `tenant:acme:region:reg01`

This prevents collisions between:

- `acme / reg01`
- `brighton / reg01`

### SettingsScopeDO

Settings fan-out is keyed by full scope string, which already includes tenant.

## D1 Model

Tables:

- `heartbeat_events`
- `devices`
- `settings_events`
- `settings_current`

Key requirements:

- `devices` uses `PRIMARY KEY (tenant, region, device_id)`
- settings tables include `tenant`
- heartbeat history includes `tenant`

## API Shape

Tenant-first route family:

- `GET /api/health`
- `POST /api/heartbeat`
- `POST /api/settings-auth`
- `GET /settings/{scope}`
- `POST /settings/{scope}`
- `GET /connect/{scope}`
- `GET /api/tenants`
- `GET /api/tenants/{tenant}/regions`
- `GET /api/tenants/{tenant}/regions/{region}/devices`
- `GET /api/tenants/{tenant}/regions/{region}/override-summary`

## Heartbeat Payload

Required identity fields:

- `tenant`
- `region`
- `device_id`

Other fields remain aligned with the demo control plane:

- `url`
- `app_version`
- `manifest_hash`
- `frame_hash`
- `viewport`
- `visibility`
- `heartbeat_policy`
- `override_summary`
- `scope_summary`

## Settings Model

Region zones remain region-default:

- `primary`
- `secondary`
- `trivia`
- `footer`

Legacy secondary scopes remain readable and writable during the canary migration:

- `secondary`

Settings writes must persist:

- tenant
- region
- optional device id
- zone
- revision
- updater metadata

## Auth Boundary

Wave 1 does not finish tenant-scoped operator auth.

But the architecture assumes future auth must prevent:

- one tenant admin reading another tenant
- one tenant admin writing another tenant settings

## Migration Policy

This backend is not a migration-in-place extension of `BDN-control-plane`.

It is a new backend line.

Migration, if ever needed later, should be explicit and one-way.

## Wave 1 Build Order

1. identity parsing and validation
2. tenant-aware scope parsing
3. tenant-aware D1 schema
4. tenant-aware DO naming
5. tenant-first route skeleton
6. health checks and smoke tests

## Out Of Scope For Initial Build

- full admin frontend
- billing
- customer self-service
- GitHub/Cloudflare automation
- cross-tenant dashboards with auth
