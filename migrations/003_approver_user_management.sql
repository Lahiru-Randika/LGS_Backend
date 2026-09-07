/* =========================================================
   Allow APPROVER to view and manage user access.

   Backend role hierarchy still prevents an APPROVER from
   granting or modifying SUPERIOR-level access.
========================================================= */

INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    r.id,
    p.id
FROM roles r
JOIN permissions p
    ON p.code IN (
        'users.read',
        'users.manage'
    )
WHERE
    r.code = 'APPROVER'
AND NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    WHERE
        rp.role_id = r.id
        AND rp.permission_id = p.id
);