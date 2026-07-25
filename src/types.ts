/**
 * The single shared vocabulary for dev-cleaner.
 *
 * Every type crossing a module boundary is declared here and nowhere else. A module may
 * define types used only inside itself; it may never redeclare one from this file.
 */

export type ProjectType =
  | 'node' | 'rust' | 'flutter' | 'xcode'
  | 'gradle' | 'python' | 'ruby' | 'go' | 'dotnet' | 'cmake';
export type Category = 'build' | 'deps' | 'cache';
export type Preset = 'recommended' | 'aggressive' | 'custom';

export interface Artifact {
  path: string; relPath: string; category: Category; bytes: number;
}
export interface GitInfo {
  branch: string; lastCommitMs: number; hasUncommittedChanges: boolean;
  isWorktree: boolean;
  worktree?: { mainRepo: string; isMerged: boolean; isClean: boolean };
}
export interface ActivityScore {
  status: 'active' | 'dormant'; idleMs: number; reason: string;
}
export interface Project {
  root: string; name: string; types: Set<ProjectType>;
  artifacts: Artifact[]; bytes: number;
  git?: GitInfo; activity: ActivityScore;
}
/** What discover() yields: no sizes, no git, no activity yet. */
export type DiscoveredProject =
  Omit<Project, 'bytes' | 'git' | 'activity'> & { isWorktree: boolean };

export interface CacheEntry {
  id: string; label: string; path: string; bytes: number; note: string;
}
export type CleanTarget =
  | { kind: 'project'; project: Project; artifact: Artifact }
  | { kind: 'cache'; cache: CacheEntry };
export type Refusal =
  | 'not-in-artifact-table' | 'outside-project-root' | 'symlink'
  | 'guarded-path' | 'worktree-root' | 'unknown-cache' | 'store-prune-unsafe'
  /**
   * The target is, or contains, a real git repository (`.git` as a *directory*).
   * Distinct from `worktree-root`, which is `.git` as a *file*. The common case is a
   * `gh-pages` deploy directory: `git clone -b gh-pages <repo> dist` makes `dist/` a
   * repository whose history exists nowhere else if it holds unpushed commits.
   */
  | 'contains-repository';
export interface CleanOutcome {
  target: CleanTarget; label: string; bytes: number;
  outcome: 'trashed' | 'refused' | 'failed';
  refusal?: Refusal; detail?: string;
}
export type TrashFn = (paths: readonly string[]) => Promise<void>;
export type SafetyReason =
  'root-is-filesystem-root' | 'root-is-home' | 'root-too-shallow';
export class SafetyError extends Error {
  constructor(readonly reason: SafetyReason, message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}
