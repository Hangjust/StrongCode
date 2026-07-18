export const EXECUTABLE_SOURCES = ["path", "association"] as const;
export type ExecutableSource = (typeof EXECUTABLE_SOURCES)[number];

export type ExecutableIdentity = {
  readonly canonicalPath: string;
  readonly sha256: string;
};

export type BlenderPaths = {
  readonly resources: {
    readonly local: string;
    readonly system: string;
    readonly user: string;
  };
  readonly config: string;
  readonly scripts: readonly string[];
  readonly extensions?: string;
};

export type BlenderProfileCandidate = {
  readonly profileId: string;
  readonly executable: ExecutableIdentity;
  readonly version: string;
  readonly paths: BlenderPaths;
  readonly sources: readonly ExecutableSource[];
};

export type CpythonCandidate = {
  readonly executable: ExecutableIdentity;
  readonly implementation: "cpython";
  readonly version: {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
  };
  readonly prefix: string;
  readonly pointerWidth: 32 | 64;
  readonly sysconfigPlatform: string;
};

export type BlenderProfileSelection =
  | { readonly kind: "none" }
  | { readonly kind: "selected"; readonly profileId: string; readonly profile: BlenderProfileCandidate }
  | { readonly kind: "required"; readonly profileIds: readonly string[] };

export type BlenderSetupDiscovery = {
  readonly workspaceBlendFile?: string;
  readonly profiles: readonly BlenderProfileCandidate[];
  readonly selection: BlenderProfileSelection;
  readonly python?: CpythonCandidate;
};

export type ProbeProcessRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly shell: false;
};

export type ProbeProcessResult =
  | {
    readonly kind: "completed";
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }
  | { readonly kind: "timeout" }
  | { readonly kind: "overflow" }
  | { readonly kind: "spawn-error"; readonly message: string };

export interface ProbeProcessAdapter {
  run(request: ProbeProcessRequest): Promise<ProbeProcessResult>;
}

export interface PlatformAssociationAdapter {
  blenderExecutables(blendFile: string | undefined): Promise<readonly string[]>;
}

export type BlenderDiscoveryLimits = {
  readonly maxWorkspaceEntries?: number;
  readonly maxWorkspaceDepth?: number;
  readonly maxCandidates?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
};

export type BlenderDiscoveryOptions = {
  readonly workspace: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly process?: ProbeProcessAdapter;
  readonly associationCommands?: ProbeProcessAdapter;
  readonly associations?: PlatformAssociationAdapter;
  readonly selectedProfileId?: string;
  readonly limits?: BlenderDiscoveryLimits;
};

export type TrustedExecutableCandidate = {
  readonly canonicalPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly sources: readonly ExecutableSource[];
};
