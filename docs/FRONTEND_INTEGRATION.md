# Existing LGS Frontend Integration

Set the Vite frontend environment variable to the backend API root:

```env
VITE_API_URL=http://localhost:4000/api/v1
```

Your API helper should keep:

```ts
credentials: 'include'
```

## AuthContext

Replace demo/local-storage authentication with:

```text
POST /auth/login
GET  /auth/me
POST /auth/logout
```

The backend response contains the authoritative role and permission list.

## Request form

Submit `POST /requests`.

For files:

```ts
const fd = new FormData()
fd.append('payload', JSON.stringify(payload))
files.forEach((file) => fd.append('files', file))
```

Do not manually set `Content-Type` for a `FormData` request; the browser sets the multipart boundary.

## Request list/detail

```text
GET /requests
GET /requests/:code
```

Use backend query parameters for filters rather than filtering all requests in React.

## Workflow actions

```text
PATCH /requests/:code/assignment
POST  /requests/:code/status-transitions
POST  /requests/:code/inspections
PATCH /inspections/:id
POST  /approvals/requests/:code/approvals
POST  /approvals/:id/decisions
```

Always send the current `version` for mutable request operations. If the API returns `409`, refetch before retrying.

## Map

Recommended backend-backed configuration:

```text
GET /map/config
GET /map/buildings.geojson
GET /map/search?q=...
GET /map/requests.geojson
```

For RGB tiles, use:

```text
http://localhost:4000/gis/cmc/rgb/{z}/{x}/{y}.png
```

For the first GIS database import, log in as the bootstrap `SUPERIOR`, then invoke:

```text
POST /api/v1/map/admin/gis/buildings/sync
```

After synchronization, building names can be manually verified with building aliases or resolved through the polygon-aware endpoint:

```text
POST /api/v1/map/buildings/:featureId/resolve
```
