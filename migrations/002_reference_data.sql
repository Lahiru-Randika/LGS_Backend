INSERT IGNORE INTO roles (code, name, description) VALUES
('CITIZEN', 'Citizen', 'Public portal user'),
('GOV_WORKER', 'Field Officer', 'Operational field worker'),
('GOV_ADMIN', 'Government Admin', 'Operational administrator and dispatcher'),
('APPROVER', 'Approver', 'Formal decision and approval role'),
('SUPERIOR', 'Municipal Superior', 'Highest application administration role');

INSERT IGNORE INTO permissions (code, description) VALUES
('map.public', 'View public map information'),
('map.internal', 'View internal map and operational layers'),
('request.create', 'Create a service request'),
('request.own.read', 'Read own requests'),
('request.assigned.read', 'Read assigned requests'),
('request.all.read', 'Read all operational requests'),
('request.update', 'Update operational requests'),
('request.assign', 'Assign requests to workers'),
('request.delete', 'Soft-delete/archive requests'),
('inspection.manage', 'Create and update inspections'),
('approval.submit', 'Submit requests for approval'),
('approval.manage', 'Decide approval requests'),
('building.public.read', 'Read public-safe building information'),
('building.sensitive.read', 'Read sensitive building/property details'),
('building.manage', 'Manage building metadata and aliases'),
('gis.manage', 'Synchronize and manage GIS data sources'),
('analytics.limited', 'View operational analytics'),
('analytics.read', 'View full municipal analytics'),
('tax.read', 'View tax and assessment information'),
('users.read', 'Read government user directory'),
('users.manage', 'Invite, disable, and change access for government users'),
('notifications.read', 'Read own notifications'),
('news.manage', 'Manage public news content'),
('contact.manage', 'Manage public contact messages'),
('audit.read', 'Read security audit logs');

-- CITIZEN
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'CITIZEN' AND p.code IN (
  'map.public','request.create','request.own.read','building.public.read','notifications.read'
);

-- GOV_WORKER
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'GOV_WORKER' AND p.code IN (
  'map.public','map.internal','request.assigned.read','request.update','inspection.manage',
  'building.public.read','notifications.read'
);

-- GOV_ADMIN
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'GOV_ADMIN' AND p.code IN (
  'map.public','map.internal','request.all.read','request.update','request.assign','inspection.manage',
  'approval.submit','building.public.read','building.sensitive.read','building.manage','analytics.limited',
  'notifications.read','contact.manage'
);

-- APPROVER
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'APPROVER' AND p.code IN (
  'map.public','map.internal','request.all.read','approval.manage','building.public.read',
  'building.sensitive.read','analytics.limited','users.read','notifications.read'
);

-- SUPERIOR receives every permission
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'SUPERIOR';

INSERT IGNORE INTO departments (code, name, description) VALUES
('ENV', 'Environmental Services', 'Waste, sanitation, drainage, and environmental matters'),
('ENG', 'Engineering', 'Roads, structures, infrastructure, and engineering works'),
('UTL', 'Utilities', 'Municipal utility coordination'),
('PLN', 'Planning', 'Planning and development control'),
('CIT', 'Citizen Services', 'Front-office citizen services'),
('OPS', 'Municipal Operations', 'Operational coordination and field services'),
('ADM', 'Municipal Administration', 'General municipal administration'),
('EXE', 'Executive Office', 'Executive and superior administration');

INSERT IGNORE INTO map_sources
(code, label, source_type, provider, source_url, proxy_url, min_zoom, max_zoom, enabled, sort_order)
VALUES
('CMC_RGB', 'CMC RGB imagery', 'RASTER_TILE', 'VISIGEO', 'https://cmc.visigeo.com/rgb/{z}/{x}/{y}.png', '/gis/cmc/rgb/{z}/{x}/{y}.png', 14, 22, 1, 10),
('CMC_BUILDINGS', 'CMC Buildings', 'GEOJSON', 'VISIGEO', 'https://cmc.visigeo.com/vector/buildings.geojson', '/api/v1/map/buildings.geojson', 14, 22, 1, 20);
