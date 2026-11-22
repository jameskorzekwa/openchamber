import type { registerFsRoutes } from '../fs/routes.js';
import type { registerEnvironmentRoutes } from '../environment/routes.js';
import type { registerSessionWarmingRoutes } from '../session-warming/routes.js';
import type { registerSessionTodosRoutes } from '../session-todos/routes.js';
import type { registerGuestRoutes } from '../guests/routes.js';
import type { registerDevServerRoutes } from '../dev-servers/routes.js';
import type { registerProjectContextRoutes } from '../project-context/routes.js';
import type { registerAgentMemoryRoutes } from '../agent-memory/routes.js';
import type { registerSessionKnowledgeRoutes } from '../session-knowledge/routes.js';
import type { registerMessageSearchRoutes } from '../message-search/routes.js';
import type { registerPermissionAutoAcceptRoutes } from '../permission-auto-accept/runtime.js';
import type { registerMessageQueueRoutes } from '../message-queue/runtime.js';
import type { registerAutoReviewRoutes } from '../auto-review/runtime.js';
import type { registerPrWatchRoutes } from '../pr-watch/runtime.js';
import type { registerExtensionWaitsRoutes } from '../extension-waits/runtime.js';
import type { registerWorkflowRoutes } from '../workflows/routes.js';
import type { registerRoutingRoutes } from '../routing/routes.js';
import type { registerSettingsUtilityRoutes } from './core-routes.js';
import type { registerProjectIconRoutes } from '../appearance/project-icon-routes.js';
import type { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import type { fillScheduledWorktreeBridge } from '../scheduled-tasks/worktree-bridge.js';
import type { registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';
import type { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import type { registerSkillRoutes } from '../opencode/skill-routes.js';
import type { registerPluginRoutes } from '../opencode/plugin-routes.js';
import type { registerOpenCodeRoutes } from '../opencode/routes.js';
import type { createTrackerRegistry } from '../trackers/registry.js';
import type { createTrackerSessionStatus } from '../trackers/session-status.js';
import type { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';
import type { SseWriter } from '../notifications/contracts.js';
import type { GlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { createSettingsRuntime } from '../settings/settings-runtime.js';
import type { createSettingsHelpers } from '../settings/settings-helpers.js';
import type { createProjectDirectoryRuntime } from '../projects/project-directory-runtime.js';
import type { createOpenCodeNetworkRuntime } from '../opencode/network-runtime.js';
import type { createExtensionNotificationChannels } from '../notifications/extension-channels.js';
import type { createWorktreeBootstrapStore } from '../git/worktree-bootstrap-storage.js';
import type { createMergeFollowRuntime } from '../github/merge-follow.js';

type PluginRouteOptions = Parameters<typeof registerPluginRoutes>[1];
export type FeatureRuntimeDependencies = Required<Pick<PluginRouteOptions, 'pluginSwitchStore' | 'isPluginSwitchAvailable' | 'refreshPluginSwitches'>> & {
  clientReloadDelayMs: number;
  trackers: ReturnType<typeof createTrackerRegistry>;
  trackerSessionStatus: Pick<ReturnType<typeof createTrackerSessionStatus>, 'forget'> | null;
};

type FsOptions = Parameters<typeof registerFsRoutes>[1];
type IconOptions = Parameters<typeof registerProjectIconRoutes>[1];
type SessionOptions = Parameters<typeof registerOpenChamberSessionRoutes>[1];
type GuestOptions = Parameters<typeof registerGuestRoutes>[1];
type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;
export interface ChangeRequestWorktreeInput<Source> {
  mode: 'existing';
  branchName: string;
  worktreeName: string;
  changeRequestSource: Source;
  startCommand?: string;
  createCommand?: string;
}
type ScheduledTaskOptions = Parameters<typeof registerScheduledTaskRoutes>[1];
type EventClient = ReturnType<ScheduledTaskOptions['getOpenChamberEventClients']> extends Set<infer Client> ? Client & SseWriter & { openchamberConnectionId?: string } : never;
export type RouteDependencies =
  & Pick<FsOptions, 'os' | 'path' | 'fsPromises' | 'spawn' | 'normalizeDirectoryPath' | 'buildAugmentedPath' | 'resolveGitBinaryForSpawn' | 'openchamberUserConfigRoot'>
  & Required<Pick<FsOptions, 'managedChatsRoot'>>
  & Pick<IconOptions, 'createFsSearchRuntime' | 'openchamberDataDir'>
  & Required<Pick<SessionOptions, 'validateDirectoryPath' | 'waitForOpenCodeReady' | 'emitSessionCreatedEvent'>>
  & Required<Pick<GuestOptions, 'onGuestDeactivated' | 'surfaceViewerHeaders' | 'openchamberVersion'>>
  & Pick<ReturnType<typeof createProjectDirectoryRuntime>, 'resolveProjectDirectory' | 'resolveOptionalProjectDirectory'>
  & Pick<Parameters<typeof registerSettingsUtilityRoutes>[1], 'readCustomThemesFromDisk' | 'saveImportedTheme' | 'deleteImportedTheme' | 'refreshOpenCodeAfterConfigChange'>
  & Pick<Parameters<typeof registerOpenCodeRoutes>[1], 'crypto' | 'getOpenCodeResolutionSnapshot' | 'getOpenCodeUpgradeCapability' | 'upgradeOpenCodeCli' | 'getOpenCodeCompatibility' | 'installOpenCodeV2'>
  & Pick<ScheduledTaskOptions, 'projectConfigRuntime' | 'scheduledTasksRuntime' | 'sanitizeProjects' | 'openchamberBuildRevision'>
  & Required<Pick<ScheduledTaskOptions, 'scheduledTaskService'>>
  & Pick<Parameters<typeof registerSkillRoutes>[1], 'sanitizeSkillCatalogs' | 'isUnsafeSkillRelativePath' | 'getOpenCodePort' | 'getManagedOpenCodeProcessEnv'>
  & {
    settingsRuntime: Pick<SettingsRuntime, 'readSettingsFromDisk' | 'readSettingsFromDiskMigrated' | 'persistSettings' | 'persistResolvedSettings' | 'watchSettingsFiles' | 'reconcileExternalSettings' | 'subscribeTakenInSettings'>;
    fs: typeof import('node:fs');
    formatSettingsResponse: ReturnType<typeof createSettingsHelpers>['formatSettingsResponse'];
    buildOpenCodeUrl: ReturnType<typeof createOpenCodeNetworkRuntime>['buildOpenCodeUrl'];
    getOpenCodeAuthHeaders: () => Record<string, string>;
    messageSearchRuntime: Parameters<typeof registerMessageSearchRoutes>[1]['messageSearchRuntime'];
    sessionWarmingRuntime: Parameters<typeof registerSessionWarmingRoutes>[1]['sessionWarmingRuntime'];
    sessionTodosRuntime: Parameters<typeof registerSessionTodosRoutes>[1]['sessionTodosRuntime'];
    onExtensionSessionEventsChanged?: () => void | Promise<void>;
    onExtensionWaitsChanged?: () => void | Promise<void>;
    extensionNotificationChannels?: ReturnType<typeof createExtensionNotificationChannels> | null;
    getOpenCodePluginDelivery?: NonNullable<NonNullable<GuestOptions['opencodePlugins']>['delivery']>;
    builtInExtensionsDir?: string | undefined;
    customThemesDir?: string | null;
    getOwnPorts: Parameters<typeof registerDevServerRoutes>[1]['getOwnPorts'];
    getActivePort?: () => number | null;
    getActiveHost?: () => string | null;
    devServerScanner: Parameters<typeof registerDevServerRoutes>[1]['scanner'];
    environmentStore: Parameters<typeof registerEnvironmentRoutes>[1]['store'];
    environmentRuntime: NonNullable<FsOptions['environmentRuntime']>;
    listConfiguredProjects: Parameters<typeof registerEnvironmentRoutes>[1]['listProjects'];
    projectContextRuntime: Parameters<typeof registerProjectContextRoutes>[1]['projectContextRuntime'];
    agentMemoryRuntime: Parameters<typeof registerAgentMemoryRoutes>[1]['agentMemoryRuntime'];
    isAgentMemoryEnabled: NonNullable<Parameters<typeof registerAgentMemoryRoutes>[1]['isAgentMemoryEnabled']>;
    sessionKnowledgeRuntime: Parameters<typeof registerSessionKnowledgeRoutes>[1]['sessionKnowledgeRuntime'];
    openChamberSessionService: NonNullable<SessionOptions['sessionService']>;
    openChamberControlService: Parameters<typeof registerOpenChamberControlRoutes>[1]['controlService'];
    getOpenChamberEventClients: () => Set<EventClient>;
    writeSseEvent: ReturnType<typeof createNotificationEmitterRuntime>['writeSseEvent'];
    permissionAutoAcceptRuntime: Parameters<typeof registerPermissionAutoAcceptRoutes>[1];
    worktreeBootstrapStore: ReturnType<typeof createWorktreeBootstrapStore>;
    scheduledWorktreeBridge: Parameters<typeof fillScheduledWorktreeBridge>[0];
    messageQueueRuntime: Parameters<typeof registerMessageQueueRoutes>[1];
    autoReviewRuntime: Parameters<typeof registerAutoReviewRoutes>[1];
    prWatchRuntime?: Parameters<typeof registerPrWatchRoutes>[1] | null;
    extensionWaitsRuntime?: Parameters<typeof registerExtensionWaitsRoutes>[1] | null;
    laterPagesRuntime?: Parameters<typeof registerOpenChamberControlRoutes>[1]['laterPages'];
    mergeFollowRuntime?: ReturnType<typeof createMergeFollowRuntime> | null;
    routingRuntime: Parameters<typeof registerRoutingRoutes>[1];
    globalEventHub: GlobalMessageStreamHub | null;
    workflowRuntime?: Parameters<typeof registerWorkflowRoutes>[1] | null;
  };
