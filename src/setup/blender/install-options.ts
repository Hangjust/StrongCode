import type { ArtifactProvenance, WheelLock } from "./artifact-manifest";
import type { VerifiedArtifactDownloader } from "./artifacts";
import type { BlenderInstallerFileSystem } from "./install-files";
import type { ActivationPhase } from "./journal";
import type { OfficialArtifactCatalog, OfficialWheelLock } from "./official-artifact-manifest";
import type { OfficialMcpProbeAdapter } from "./official-mcp-probe";
import type { stageOfficialBlenderAddon, enableOfficialBlenderExtension, probeOfficialBlenderExtension } from "./official-addon";
import type { stageOfficialBlenderRuntime } from "./official-runtime";
import type { EnvironmentFileSystem, EnvironmentProcessAdapter } from "./python-env";
import type { LegacyBlenderIntegrationSelection, OfficialBlenderIntegrationSelection } from "./selection";
import type { CpythonCandidate, ProbeProcessAdapter } from "./types";

type CommonInstallBlenderIntegrationOptions = {
  readonly homePath: string;
  readonly python: CpythonCandidate;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly blenderProcess?: ProbeProcessAdapter;
  readonly files?: BlenderInstallerFileSystem;
  readonly env?: NodeJS.ProcessEnv;
  readonly repair?: boolean;
  readonly verifyOnly?: boolean;
  readonly phaseHook?: (phase: ActivationPhase) => void | Promise<void>;
};

export type LegacyInstallBlenderIntegrationOptions = CommonInstallBlenderIntegrationOptions & {
  readonly selection: LegacyBlenderIntegrationSelection;
  readonly lock: WheelLock;
  readonly provenance: ArtifactProvenance;
  readonly requirements: string;
  readonly wrapperAssetsPath: string;
  readonly addonAssetsPath: string;
  readonly downloader?: VerifiedArtifactDownloader;
  readonly environmentProcess?: EnvironmentProcessAdapter;
  readonly environmentFiles?: EnvironmentFileSystem;
  readonly mcpProbe?: OfficialMcpProbeAdapter;
  readonly extensionProbe?: typeof probeOfficialBlenderExtension;
};

export type OfficialInstallBlenderIntegrationOptions = CommonInstallBlenderIntegrationOptions & {
  readonly selection: OfficialBlenderIntegrationSelection;
  readonly catalog: OfficialArtifactCatalog;
  readonly lock: OfficialWheelLock;
  readonly requirements: string;
  readonly derivativeAssetsPath: string;
  readonly downloader?: VerifiedArtifactDownloader;
  readonly environmentProcess?: EnvironmentProcessAdapter;
  readonly environmentFiles?: EnvironmentFileSystem;
  readonly mcpProbe?: OfficialMcpProbeAdapter;
  readonly runtimeStager?: typeof stageOfficialBlenderRuntime;
  readonly addonStager?: typeof stageOfficialBlenderAddon;
  readonly extensionEnabler?: typeof enableOfficialBlenderExtension;
  readonly extensionProbe?: typeof probeOfficialBlenderExtension;
};

export type InstallBlenderIntegrationOptions =
  | LegacyInstallBlenderIntegrationOptions
  | OfficialInstallBlenderIntegrationOptions;
