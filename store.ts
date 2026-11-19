// The forge store: users, repositories, issues, comments, labels and pull requests over
// one git object store per repository. All state is in memory; the trial pod is read-only
// and the store starts empty each trial.
//
// Fixed identities (kit data, trial-invariant by construction — see SCOPE.md §4): the
// bearer token names viewer `adaiversen` (id 1000); the stranger is `olgabauer` (1002).
// Determinism: every timestamp comes from MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms), every
// id is sequential, nothing reads the wall clock or an unseeded random source.

import { GitRepo } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@users.noreply.github.com';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const TEAMMATE_ID = 1001;
export const STRANGER_LOGIN = 'olgabauer';
export const STRANGER_ID = 1002;
export const ORG_LOGIN = 'faint-meadow-org';

/** The trial's fixed now in epoch milliseconds. */
export const TRIAL_NOW_MS: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Local runs set no trial now; a fixed fallback keeps every run deterministic.
  return Date.parse('2026-11-19T00:00:00.000Z');
})();

/** The trial's fixed now as an ISO 8601 instant. */
export function nowIso(): string {
  return new Date(TRIAL_NOW_MS).toISOString();
}

/** The trial's fixed now as git epoch seconds. */
export function nowEpochSeconds(): number {
  return Math.floor(TRIAL_NOW_MS / 1000);
}

export interface UserJson {
  login: string;
  id: number;
  type: string;
}

export function viewerUser(): UserJson {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export function labelJson(label: Label): { name: string; color: string; description: string } {
  return { name: label.name, color: label.color, description: label.description };
}

export interface Comment {
  id: number;
  body: string;
  user: UserJson;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: UserJson;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: UserJson;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** One shared counter for issues and pull requests, as GitHub numbers them. */
  nextNumber: number;
  nextCommentId: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  git: GitRepo;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string, defaultBranch = 'main'): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      fullName: key,
      isPrivate,
      description,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
      nextNumber: 1,
      nextCommentId: 1,
      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
      git: new GitRepo(),
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The owner's repositories in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  nextGlobal(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : STRANGER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: issue.user,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}

export function commentJson(comment: Comment, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: comment.user,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `/api/v3/repos/${repo.fullName}/issues/${issueNumber}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
  };
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: viewerUser(),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: viewerUser(),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: true,
    draft: false,
    user: pull.user,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}
