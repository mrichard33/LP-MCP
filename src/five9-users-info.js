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
export function normalizeRoles(rolesRaw) {
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

/* ---------------------------------------------------------------------- *
 * User profiles (2026-08-21 Phase H).
 *
 * A user profile is a named bundle of roles, skills and membership that can
 * be attached to many users at once. Reece runs two — "Level 1 Setter
 * Profile" (5 LightFire agents) and "Level 2 Setter Profile" (1 NC hire) —
 * and until now LP MCP had no way to read either. An earlier Phase H
 * operation index denied the whole op family on the belief that no profile
 * was in use, which was already false when it was written.
 *
 * These readers live HERE rather than in five9-admin.js for one concrete
 * reason: a userProfile carries a <roles> block of the same tns:userRoles
 * type as a user record, and normalizeRoles already owns that shape.
 * five9-admin.js cannot import it back without a cycle (this module imports
 * five9-admin.js), so the profile readers follow the normalizer.
 *
 * THE ELEMENT NAME BELOW IS MISSPELLED IN FIVE9'S OWN v13 WSDL:
 *
 *   <xs:complexType name="getUserProfiles"><xs:sequence>
 *     <xs:element minOccurs="0" name="userProfileNamePatern" type="xs:string"/>
 *
 * "Patern", one t. Verified against src/five9/wsdl-schema.json, which is
 * generated from the live WSDL rather than hand-transcribed. Emitting the
 * correct spelling sends an element the server does not know. This is the
 * same class of trap as `dispostionName` on campaignCallWrapup — do not
 * "fix" it, and do not let a linter fix it either.
 * ---------------------------------------------------------------------- */

// Exported so a test can assert the misspelling verbatim rather than
// re-deriving it, and so the write side builds the same string.
export const USER_PROFILE_NAME_PATTERN_ELEMENT = 'userProfileNamePatern';

/** Five9 admin name patterns are REGEXES, so match-all is `.*`, not "". */
export const MATCH_ALL_PATTERN = '.*';

/**
 * normalizeUserProfile — one userProfile <return> block into a stable shape.
 *
 * `roles` is deliberately expanded here rather than left raw: the whole point
 * of the read is that a caller can see which roles a profile GRANTS — and
 * therefore what every user carrying it inherits — without a second call.
 * assigned[] is the answer to "does this profile hand out admin", which is
 * the question that matters before anyone modifies one.
 */
export function normalizeUserProfile(raw) {
  const roles = normalizeRoles(raw?.roles);
  const strings = (v) => asArray(v).filter(s => typeof s === 'string' && s !== '');
  return {
    name: raw?.name ?? null,
    description: raw?.description ?? null,
    locale: raw?.locale ?? null,
    IEXScheduled: raw?.IEXScheduled === 'true',
    mediaTypeConfig: raw?.mediaTypeConfig ?? null,
    roles: { assigned: roles.assigned, permissions: roles.permissions },
    skills: strings(raw?.skills),
    users: strings(raw?.users),
    raw,
  };
}

/**
 * getUserProfiles — every profile matching a Five9 name REGEX.
 * Empty/omitted pattern means "all", expressed as `.*` because an empty
 * string is not a reliable match-all on this API.
 */
export async function getUserProfiles(namePattern = MATCH_ALL_PATTERN) {
  const p = String(namePattern || MATCH_ALL_PATTERN);
  const el = USER_PROFILE_NAME_PATTERN_ELEMENT; // misspelled per the WSDL
  const xml = await five9SoapCall('getUserProfiles', `<${el}>${escapeXml(p)}</${el}>`);
  const profiles = returnBlocks(xml).map(parseXmlBlock).map(normalizeUserProfile).filter(p => p.name);
  return { count: profiles.length, profiles };
}

/**
 * getUserProfile — ONE profile by exact name. Returns null when absent
 * rather than throwing, so callers can treat "no such profile" as data.
 * (The write-side existence guard depends on that.)
 */
export async function getUserProfile(profileName) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('profileName is required');
  const xml = await five9SoapCall('getUserProfile', `<userProfileName>${escapeXml(name)}</userProfileName>`);
  const block = returnBlocks(xml)[0];
  if (!block) return null;
  const profile = normalizeUserProfile(parseXmlBlock(block));
  return profile.name ? profile : null;
}
