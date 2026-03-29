# Investment Tracker

A web application for tracking personal investments, planning milestones, and monitoring portfolio evolution.

## Features

### Portfolio Operations
- Add buy/sell transactions with units, unit price, date, fund, and platform.
- Edit and delete transactions (single and bulk).
- Search, filter, sort, and paginate transactions.
- Validate and import JSON/XLSX datasets before applying.

### Portfolio Analytics
- Portfolio summary by fund and platform.
- Distribution charts and asset evolution chart.
- Multi-currency support with automatic conversion.
- Net worth tracking (assets and liabilities).

### Planning
- Objective tracking with progress.
- Local forecast generation for estimated time-to-goal (no external model service).
- Milestones with status, progress, and estimated completion.
- Safe withdrawal planning based on selected SWR rates.

### Tax Tracking
- Profit entries and yearly summaries.
- CASS-related settings and threshold visibility.

## Technology Stack

- Backend: Node.js (vanilla HTTP server)
- Frontend: React 18 + Vite (production bundle served by backend)
- Charts: Chart.js
- Import/Export: SheetJS
- Containerization: Docker + Docker Compose

## Quick Start (Docker)

1. From the repository root:

```bash
docker compose up --build -d
```

2. Open:

```text
http://localhost:3000
```

3. Stop:

```bash
docker compose down
```

## Architecture

- `investments-app/backend/server.js`
  - REST API
  - JSON-file persistence (`investments-app/backend/data.json`)
  - Static asset serving from `investments-app/backend/public`
- `investments-app/frontend`
  - React app built with Vite
  - Build output copied into backend `public/`

## API Endpoints

### Investments
- `GET /api/investments`
  - Supports query params: `page`, `pageSize`, `sortBy`, `sortDir`, `search`, `fund`, `platform`, `dateFrom`, `dateTo`
  - Legacy array mode: `?legacy=1`
- `POST /api/investments`
- `PUT /api/investments/:id`
- `DELETE /api/investments/:id`
- `POST /api/investments/bulk-delete`

### Portfolio & Planning
- `GET /api/rates`
- `GET /api/portfolio/summary?currency=...`
- `GET /api/objective`
- `POST /api/objective`
- `GET /api/prediction`
- `POST /api/prediction`
  - Uses local deterministic forecast logic (no external model dependency)
- `GET /api/milestones`
- `POST /api/milestones`
- `GET /api/net-worth`
- `POST /api/net-worth`

### Profit/Tax
- `GET /api/profit`
- `POST /api/profit`

### Import
- `POST /api/import/validate`
- `POST /api/import`

## Environment Variables

- `PORT` (default: `3000`)

## Local Development

Run backend tests:

```bash
cd investments-app/backend
npm test
```

Build frontend manually:

```bash
cd investments-app/frontend
npm run build
```

## Troubleshooting

Show backend logs:

```bash
docker compose logs --tail=200 backend
```

Rebuild after code changes:

```bash
docker compose up --build -d
```
