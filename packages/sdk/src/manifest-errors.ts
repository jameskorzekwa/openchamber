import { OPENCHAMBER_SDK_MANIFEST_API_VERSIONS } from './api-version.ts';
import {
  DECLARED_GUEST_CAPABILITIES,
  GUEST_BLOCKS_MAX, GUEST_BLOCK_ARGS_MAX, GUEST_BLOCK_DESCRIPTION_MAX,
  GUEST_LINK_KEYS_MAX, GUEST_MENTIONS_LABEL_MAX, GUEST_ORIGINS_MAX, GUEST_PROVIDER_LOGOS_MAX,
  GUEST_STATUS_SECTION_HEIGHT_MAX, GUEST_STATUS_SECTION_HEIGHT_MIN, GUEST_STATUS_SECTION_TITLE_MAX,
  GUEST_SURFACE_DOCKS, GUEST_SURFACE_DOCK_SIZE_MAX, GUEST_SURFACE_DOCK_SIZE_MIN,
  GUEST_TONES, GUEST_TOOL_CARD_FIELDS_MAX, GUEST_TOOL_CARD_TONES_MAX,
  QUOTA_PROVIDERS_MAX, TRACKER_IDENTIFIER_KINDS,
  type ParseManifestErrorCode, type ParseManifestFailure,
} from './manifest.ts';
import { GUEST_SESSION_EVENT_TYPES } from './session-events.ts';
import { GUEST_STATUS_SOURCE_INTERVAL_MAX, GUEST_STATUS_SOURCE_INTERVAL_MIN } from './status-view.ts';
import { GUEST_FILE_EDITORS_MAX, GUEST_FILE_EDITOR_PATTERNS_MAX, GUEST_FILE_EDITOR_TITLE_MAX } from './file-editor.ts';
import {
  GUEST_WAITS_MAX, GUEST_WAIT_DESCRIPTION_MAX, GUEST_WAIT_PARAMS_MAX,
  GUEST_WAIT_PARAM_TYPES, GUEST_WAIT_TITLE_MAX, WAIT_CHECK_INTERVAL_MAX, WAIT_CHECK_INTERVAL_MIN,
} from './waits.ts';

const DECLARED_CAPABILITIES_MESSAGE = `contributes.capabilities may list ${DECLARED_GUEST_CAPABILITIES.map((capability) => `"${capability}"`).join(', ')}.`;

export const fail = (code: ParseManifestErrorCode, message: string): ParseManifestFailure => ({
  ok: false,
  code,
  message,
});

const fieldPath = (issuePath: ReadonlyArray<PropertyKey>): string => (issuePath[0] === 'openchamber' ? issuePath.slice(1) : issuePath)
  .reduce<string>((field, segment) => (Number.isInteger(segment) ? `${field}[${String(segment)}]` : `${field ? `${field}.` : ''}${String(segment)}`), '');

export const failureFromIssue = (issue: { path: ReadonlyArray<PropertyKey>; code: string; message: string }): ParseManifestFailure => {
  const segments = issue.path.map(String);
  const path = (segments[0] === 'openchamber' ? segments.slice(1) : segments).join('.');
  const isPackageEnvelope = segments[0] === 'openchamber';
  if (!path && issue.code === 'invalid_type') {
    return isPackageEnvelope
      ? fail('missing-openchamber', 'package.json openchamber must be a plain object.')
      : fail('not-object', 'Manifest must be a plain object.');
  }
  if (segments.length === 1 && segments[0] === 'version') {
    return fail('invalid-version', 'package.json version must be semver like 1.0.0.');
  }
  if (path === 'apiVersion') {
    return fail(
      'unsupported-api-version',
      `Unsupported apiVersion. This host accepts ${OPENCHAMBER_SDK_MANIFEST_API_VERSIONS.join(' and ')}.`,
    );
  }
  if (path === 'engines' || path.startsWith('engines.')) {
    return fail('invalid-engines', 'engines.openchamber must be a version like 1.22.0 or >=1.22.0.');
  }
  if (path === 'contributes.panel' && issue.code === 'custom') {
    return fail('invalid-panel', issue.message);
  }
  if (path === 'contributes' || path === 'contributes.panel') {
    return fail('missing-panel', 'The manifest needs id, name and icon.');
  }
  switch (path) {
    case 'contributes.panel.id':
      return fail('invalid-panel-id', 'id must be kebab-case starting with a letter.');
    case 'contributes.panel.name':
      return fail('invalid-panel-name', 'name must be a non-empty string.');
    case 'contributes.panel.icon':
      return fail('invalid-panel-icon', 'icon must be a Remixicon name or a package .svg path.');
    case 'contributes.panel.entry':
      return fail('invalid-panel-entry', 'panel.entry must be a relative path inside the package.');
    case 'contributes.panel.dock':
      return fail('invalid-panel', issue.code === 'custom'
        ? issue.message
        : `panel.dock is one of ${GUEST_SURFACE_DOCKS.join(', ')}.`);
    case 'contributes.panel.size':
      return fail('invalid-panel', `panel.size is a whole number of CSS pixels from ${GUEST_SURFACE_DOCK_SIZE_MIN} to ${GUEST_SURFACE_DOCK_SIZE_MAX}.`);
    case 'contributes.panel.mobile':
      return fail('invalid-panel', 'panel.mobile is true or left out.');
    case 'contributes.capabilities':
      return fail('invalid-capabilities', DECLARED_CAPABILITIES_MESSAGE);
    default:
      break;
  }
  if (path === 'contributes.page' || path.startsWith('contributes.page.')) {
    return fail('invalid-page', 'contributes.page must be true or { entry: "<package HTML>", title?: "Page title", mobile?: true }.');
  }
  if (path === 'contributes.statusSection' || path.startsWith('contributes.statusSection.')) {
    return fail('invalid-status-section', issue.code === 'custom'
      ? issue.message
      : `contributes.statusSection must be true or { entry?: "<package .html>", source?: { path: "/status", interval?: ${GUEST_STATUS_SOURCE_INTERVAL_MIN} to ${GUEST_STATUS_SOURCE_INTERVAL_MAX} }, title?: "1 to ${GUEST_STATUS_SECTION_TITLE_MAX} characters", height?: ${GUEST_STATUS_SECTION_HEIGHT_MIN} to ${GUEST_STATUS_SECTION_HEIGHT_MAX} } with entry, source, or both.`);
  }
  if (path === 'contributes.background' || path.startsWith('contributes.background.')) {
    return fail('invalid-background', 'contributes.background needs an entry ending in .html inside the package.');
  }
  if (path === 'contributes.attach' || path.startsWith('contributes.attach.')) {
    return fail(
      'invalid-attach',
      'contributes.attach must be true, false, "panel", "dialog", or { "mode": "panel" | "dialog", "entry"?: "<html inside the package, dialog only>" }.',
    );
  }
  if (path.startsWith('contributes.capabilities')) {
    return fail('invalid-capabilities', DECLARED_CAPABILITIES_MESSAGE);
  }
  if (path.startsWith('contributes.filesystem')) {
    return fail(
      'invalid-filesystem',
      'contributes.filesystem lists 1 to 16 patterns starting with "/" or "~/", without "..", empty segments, or backslashes.',
    );
  }
  if (path.startsWith('contributes.origins')) {
    return fail(
      'invalid-origins',
      `contributes.origins lists 1 to ${GUEST_ORIGINS_MAX} unique https origins like "https://fonts.example.com", without a path.`,
    );
  }
  if (path.startsWith('contributes.actions')) {
    return fail(
      'invalid-actions',
      'contributes.actions lists up to 8 entries with a unique kebab-case id, a label of 1 to 40 characters, where "message", "session", "selection", "file" or "diff", optional roles (message only), optional payload ["messages"] (session only), and optional display "label", "icon" or "both" (selection only).',
    );
  }
  if (path.startsWith('contributes.commands')) {
    return fail(
      'invalid-commands',
      'contributes.commands lists up to 8 entries with a unique name matching /^[a-z][a-z0-9-]{0,23}$/ and an optional description of 1 to 80 characters.',
    );
  }
  if (path.startsWith('contributes.tools')) {
    return fail('invalid-tools', issue.code === 'custom' && segments.includes('card')
      ? `${fieldPath(issue.path)}: ${issue.message}`
      : `contributes.tools lists up to 16 entries with a match of 1 to 128 characters ([A-Za-z0-9_.:-], "*" only at the end), optional name (1 to 40), icon (Remixicon name or package .svg path), title and subtitle templates (1 to 200), output "auto" | "text" | "json" | "markdown" | "code" | "table" | "card", language (code only), columns (table only, 1 to 16), and card (card only): { label?, title?, status?: { value, tones?: up to ${GUEST_TOOL_CARD_TONES_MAX} of "status text": ${GUEST_TONES.map((tone) => `"${tone}"`).join(' | ')} }, fields?: 1 to ${GUEST_TOOL_CARD_FIELDS_MAX} of { label, value }, link?: { label, url } } with no other keys, where label, title, status.value, fields[].value and link.url are templates (1 to 200) and the other labels are text (1 to 40).`);
  }
  if (path.startsWith('contributes.providerLogos')) {
    return fail(
      'invalid-provider-logos',
      `contributes.providerLogos maps 1 to ${GUEST_PROVIDER_LOGOS_MAX} OpenCode provider ids, like "openrouter", to a .svg or .png file inside the package.`,
    );
  }
  if (path.startsWith('contributes.fileEditors')) {
    return fail(
      'invalid-file-editors',
      `contributes.fileEditors lists 1 to ${GUEST_FILE_EDITORS_MAX} editors with a unique kebab-case id, a title of 1 to ${GUEST_FILE_EDITOR_TITLE_MAX} characters, match: 1 to ${GUEST_FILE_EDITOR_PATTERNS_MAX} file-name patterns (no "/", not only wildcards, like "*.excalidraw"), an entry ending in .html inside the package, and optional content "text" or "binary".`,
    );
  }
  if (path === 'contributes.sessionEvents' || path.startsWith('contributes.sessionEvents.')) {
    return fail('invalid-session-events', issue.code === 'custom' && path === 'contributes.sessionEvents'
      ? issue.message
      : `contributes.sessionEvents is { events: [1 to ${GUEST_SESSION_EVENT_TYPES.length} distinct of ${GUEST_SESSION_EVENT_TYPES.map((type) => `"${type}"`).join(', ')}], content?: true }.`);
  }
  if (path === 'contributes.sessionControl' || path.startsWith('contributes.sessionControl.')) {
    return fail('invalid-session-control', issue.code === 'custom' ? issue.message : 'contributes.sessionControl is { content?: true, answers?: true }.');
  }
  if (path === 'contributes.instructions') {
    return fail('invalid-instructions', issue.code === 'custom' ? issue.message : 'contributes.instructions is true.');
  }
  if (path === 'contributes.marks') {
    return fail('invalid-marks', issue.code === 'custom' ? issue.message : 'contributes.marks is true.');
  }
  if (path === 'contributes.skills') {
    return fail('invalid-skills', 'contributes.skills is a folder inside the package.');
  }
  if (path === 'contributes.opencodePlugin') {
    return fail('invalid-opencode-plugin', 'contributes.opencodePlugin is a plugin folder inside the package: a directory with a package.json whose entry OpenCode loads.');
  }
  if (path === 'contributes.mentions' || path.startsWith('contributes.mentions.')) {
    return fail('invalid-mentions', issue.code === 'custom' ? issue.message : `contributes.mentions is { label: 1 to ${GUEST_MENTIONS_LABEL_MAX} characters }.`);
  }
  if (path === 'contributes.blocks' || path.startsWith('contributes.blocks')) {
    return fail(
      'invalid-blocks',
      `contributes.blocks lists 1 to ${GUEST_BLOCKS_MAX} components, each with a unique PascalCase name, a description of 1 to ${GUEST_BLOCK_DESCRIPTION_MAX} characters, up to ${GUEST_BLOCK_ARGS_MAX} unique camelCase args, an entry ending in .html inside the package, and an optional height.`,
    );
  }
  if (path === 'contributes.links' || path.startsWith('contributes.links.')) {
    const field = fieldPath(issue.path);
    return fail('invalid-links', issue.code === 'custom'
      ? `${field}: ${issue.message}`
      : `${field} is invalid: contributes.links is { action: "open" | "attach", identifier?: { keys: 1 to ${GUEST_LINK_KEYS_MAX} upper-case keys like "PROJ" }, urls?: { origin: "https://...", identifier: ${TRACKER_IDENTIFIER_KINDS.map((kind) => `"${kind}"`).join(' | ')}, item: link templates } }.`);
  }
  if (path === 'contributes.waits' || path.startsWith('contributes.waits.')) {
    return fail('invalid-waits', issue.code === 'custom' && path === 'contributes.waits'
      ? issue.message
      : `${fieldPath(issue.path)} is invalid: contributes.waits lists 1 to ${GUEST_WAITS_MAX} entries with a unique kebab-case id, a title of 1 to ${GUEST_WAIT_TITLE_MAX} characters, a description of 1 to ${GUEST_WAIT_DESCRIPTION_MAX}, up to ${GUEST_WAIT_PARAMS_MAX} params of type ${GUEST_WAIT_PARAM_TYPES.map((type) => `"${type}"`).join(', ')}, and an optional interval of ${WAIT_CHECK_INTERVAL_MIN} to ${WAIT_CHECK_INTERVAL_MAX} ms.`);
  }
  if (path.startsWith('contributes.integration')) {
    return fail(
      'invalid-integration',
      'contributes.integration needs a name, description, and oauth, token, or host.',
    );
  }
  if (path.startsWith('contributes.sourceControl')) {
    const field = fieldPath(issue.path);
    return fail('invalid-service', issue.code === 'custom'
      ? `${field}: ${issue.message}`
      : `${field} is invalid: see "contributes.sourceControl" in GUEST_SERVICES.md for every field.`);
  }
  if (path.startsWith('contributes.notifications')) {
    const field = fieldPath(issue.path);
    return fail('invalid-service', issue.code === 'custom'
      ? `${field}: ${issue.message}`
      : `${field} is invalid: see "contributes.notifications" in GUEST_SERVICES.md for every field.`);
  }
  if (path.startsWith('contributes.tracker')) {
    const field = fieldPath(issue.path);
    return fail('invalid-service', issue.code === 'custom'
      ? `${field}: ${issue.message}`
      : `${field} is invalid: see "contributes.tracker" in GUEST_SERVICES.md for every field.`);
  }
  if (path.startsWith('contributes.quota')) {
    const field = fieldPath(issue.path);
    return fail('invalid-service', issue.code === 'custom'
      ? `${field}: ${issue.message}`
      : `${field} is invalid: contributes.quota is { providers: string[] } of up to ${QUOTA_PROVIDERS_MAX} OpenCode provider ids; see "Usage provider" in GUEST_SERVICES.md.`);
  }
  if (path.startsWith('contributes.service')) {
    return fail('invalid-service', issue.code === 'custom'
      ? issue.message
      : 'contributes.service needs entry, runtime "host", optional permissions, optional provides ("browser", "source-control", "notifications", "tracker", "quota", "opencode"), optional surface (true), optional keepRunning (true), and optional schedule (up to 8 of { id, cron, timezone? }).');
  }
  return fail('missing-panel', 'The manifest needs id, name and icon.');
};
