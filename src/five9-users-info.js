/**
 * Five9 full user info — src/five9-users-info.js
 *
 * Companion to getUsersGeneralInfo() in src/five9-admin.js.
 *
 * WHY THIS MODULE EXISTS: the Five9 Admin SOAP API exposes user data through
 * two different operations, and they do NOT return the same shape.
 *
 *   getUsersGeneralInfo -> ONLY the <generalInfo> block: userName, names,
 *                          email, extension, active flag, mediaTypeConfig.
 *                          Roles, skills and agent groups are absent BY
 *                          DESIGN — not by permission.
 *   getUsersInfo        -> the full <userInfo> record: generalInfo PLUS
 *                          <roles>, <skills>, <agentGroups>, <cannedReports>.
 *
 * LP MCP only ever called the first one, so every role/skill audit came back
 * empty and looked like a service-account permissions problem when it was a
 * wrong-operation problem. This module adds the second call.
 *
 * Read-only. Same endpoint and auth as src/five9-admin.js
 * (FIVE9_USERNAME / FIVE9_PASSWORD Railway env vars). No write methods here —
 * Five9 writes execute ONLY via create_agent_action -> approve_action.
 */

import {
  five9SoapCall,
  returnBlocks,
  parseXmlBlock,
  asArray,
  escapeXml,
} from './five9-admin.js';

/**
 * normalizeRoles — Five9 omits the element entirely for an unassigned role,
 * so presence means assigned; a present-but-empty element still counts.
 * Role names are read off the response rather than hardcoded so non-core
 * roles (e.g. contactRecordsManager) are not silently dropped.
 */
function normalizeRoles(rolesRaw) {
  const assigned = [];
  const permissions = {};
  if (!rolesRaw || typeof rolesRaw !== 'object') return { assigned, permissions };
  for (const [roleName, node] of Object.entries(rolesRaw)) {
    if (node === undefined) continue;
    assigned.push(roleName);
    const perms = asArray(node && typeof node === 'object' ? node.permissions : null)
      .filter(p => p && typeof p === 'object' && p.type)
      .map(p => ({ type: p.type, value: p.value === 'true' }));
    if (perms.length) permissions[roleName] = perms;
  }
  return { assigned, permissions };
}

/** normalizeSkills — <skills>{id, skillName, level}</skills>, repeated. */
function normalizeSkills(skillsRaw) {
  return asArray(skillsRaw)
    .filter(s => s && typeof s === 'object')
    .map(s => ({
      id: s.id ?? null,
      name: s.skillName ?? s.name ?? null,
      level: (s.level === undefined || s.level === null || s.level === '')
        ? null
        : Number(s.level),
    }))
    .filter(s => s.name || s.id);
}

/**
 * getUsersFullInfo — user records WITH roles, role permissions, skills and
 * agent groups. Heavier than getUsersGeneralInfo (a full permission tree per
 * user), so narrow with `pattern` whenever the caller can.
 *
 * Returns { count, users[] } where each user carries flattened top-level
 * identity fields for convenience plus the untouched generalInfo block.
 */
export async function getUsersFullInfo(pattern = '.*') {
  const p = String(pattern || '.*');
  const xml = await five9SoapCall(
    'getUsersInfo',
    `<userNamePattern>${escapeXml(p)}</userNamePattern>`
  );
  const users = returnBlocks(xml).map(parseXmlBlock).map(u => {
    const generalRaw = (u && typeof u.generalInfo === 'object' && u.generalInfo) || {};
    const { password, ...general } = generalRaw; // never surface a credential field
    const roles = normalizeRoles(u?.roles);
    return {
      userName: general.userName ?? null,
      fullName: general.fullName ?? null,
      EMail: general.EMail ?? null,
      extension: general.extension ?? null,
      active: general.active === 'true',
      userProfileName: general.userProfileName ?? null,
      roles: roles.assigned,
      role_permissions: roles.permissions,
      skills: normalizeSkills(u?.skills),
      agentGroups: asArray(u?.agentGroups).filter(g => typeof g === 'string' && g),
      generalInfo: general,
    };
  });
  return { count: users.length, users };
}
