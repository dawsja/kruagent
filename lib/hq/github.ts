export type GithubRepo = {
  full_name: string;
  default_branch: string;
  private: boolean;
  pushed_at: string | null;
};

type RepoRow = {
  full_name: string;
  default_branch: string;
  private: boolean;
  pushed_at?: string | null;
};

/**
 * GitHub refused a read the app's permissions don't cover, e.g. check runs
 * on an app created before Kru asked for `checks: read`. The caller names
 * the permission, since only it knows which endpoint it asked.
 */
export class GithubPermissionError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubPermissionError";
  }
}

const holder = globalThis as typeof globalThis & { __kruGithubBackoff?: number };

/**
 * When GitHub's rate limit is nearly spent, the moment (epoch ms) it resets;
 * 0 while there is room. Polling waits for it rather than burning the last
 * requests a person may need for an approve.
 */
export function githubBackoffUntil(): number {
  return holder.__kruGithubBackoff ?? 0;
}

/** Requests kept in reserve for the person's own clicks. */
const RATE_LIMIT_RESERVE = 50;

function noteRateLimit(res: Response) {
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || !res.headers.has("x-ratelimit-remaining")) return;
  holder.__kruGithubBackoff = remaining < RATE_LIMIT_RESERVE ? reset * 1000 : 0;
}

async function shortMessage(res: Response) {
  const raw = await res.text().catch(() => "");
  try {
    return (JSON.parse(raw) as { message?: string }).message ?? raw;
  } catch {
    return raw;
  }
}

async function refuse(res: Response, path: string, verb: string): Promise<never> {
  const message = (await shortMessage(res)).slice(0, 200);
  if (res.status === 403 && /not accessible/i.test(message)) {
    throw new GithubPermissionError(path, `GitHub ${verb} ${path} refused: ${message}`);
  }
  throw new Error(`GitHub ${verb} ${path} failed (${res.status})${message ? `: ${message}` : ""}`);
}

function headers(token: string, extra: Record<string, string> = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kru-agent-hq",
    ...extra,
  };
}

export async function githubGet<T>(
  token: string,
  path: string,
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers(token) });
  noteRateLimit(res);
  if (!res.ok) await refuse(res, path, "GET");
  return (await res.json()) as T;
}

export type Conditional<T> = { changed: false } | { changed: true; data: T; etag: string | null };

/**
 * A GET that GitHub answers 304 to while nothing has changed, given the
 * ETag from the last answer. A 304 costs nothing against the rate limit,
 * which is what makes polling every few seconds affordable.
 */
export async function githubGetConditional<T>(
  token: string,
  path: string,
  etag?: string | null,
): Promise<Conditional<T>> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: headers(token, etag ? { "If-None-Match": etag } : {}),
    // Kru does the caching here, with the ETag; nothing else may cache it,
    // or a stale body would look like a pull request that never merges.
    cache: "no-store",
  });
  noteRateLimit(res);
  if (res.status === 304) return { changed: false };
  if (!res.ok) await refuse(res, path, "GET");
  return { changed: true, data: (await res.json()) as T, etag: res.headers.get("etag") };
}

export async function githubSend(
  token: string,
  path: string,
  method: string,
  body?: unknown,
) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: headers(token, { "Content-Type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  noteRateLimit(res);
  // Only GitHub's short message is kept; full bodies end up in run logs.
  if (!res.ok) await refuse(res, path, method);
  if (res.status === 204) return null;
  return res.json();
}

function mapRepo(row: RepoRow): GithubRepo {
  return {
    full_name: row.full_name,
    default_branch: row.default_branch,
    private: row.private,
    pushed_at: row.pushed_at ?? null,
  };
}

function pushedTime(repo: GithubRepo) {
  return (repo.pushed_at ? Date.parse(repo.pushed_at) : 0) || 0;
}

/** Most recently pushed first, so the first repo is the natural default. */
function byRecentPush(repos: GithubRepo[]) {
  return repos.sort((a, b) => pushedTime(b) - pushedTime(a));
}

/** One repo, including its real default branch. */
export async function getRepo(token: string, repo: string): Promise<GithubRepo> {
  const row = await githubGet<RepoRow>(token, `/repos/${repo}`);
  return mapRepo(row);
}

export async function listInstallations(
  token: string,
): Promise<{ id: number; account: string }[]> {
  const data = await githubGet<{
    installations: { id: number; account: { login: string } }[];
  }>(token, "/user/installations");
  return (data.installations ?? []).map((item) => ({
    id: item.id,
    account: item.account.login,
  }));
}

export async function listRepos(token: string): Promise<GithubRepo[]> {
  try {
    const installations = await listInstallations(token);
    const repos: GithubRepo[] = [];
    for (const installation of installations) {
      const page = await githubGet<{ repositories: RepoRow[] }>(
        token,
        `/user/installations/${installation.id}/repositories?per_page=100`,
      );
      for (const repo of page.repositories ?? []) {
        repos.push(mapRepo(repo));
      }
    }
    if (repos.length > 0) return byRecentPush(repos);
  } catch {
    /* fall through to user repos */
  }
  const rows = await githubGet<RepoRow[]>(token, "/user/repos?per_page=100&sort=pushed");
  return byRecentPush(rows.map(mapRepo));
}

export function parsePullUrl(url: string): { repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { repo: match[1], number: Number(match[2]) };
}

export type PullState = "open" | "closed" | "merged";

export type PullCheck =
  | { changed: false }
  | { changed: true; state: PullState; etag: string | null; number: number; headSha: string | null };

type RawPull = { number?: number; merged?: boolean; state?: string; head?: { sha?: string } };

function pullState(pull: RawPull): PullState {
  return pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open";
}

/**
 * Asks GitHub what happened to a pull request, conditionally: with the
 * `etag` from the last answer, 304 while nothing changed. The head commit
 * comes along, so checks can be read for exactly what Kru pushed.
 */
export async function checkPull(
  token: string,
  repo: string,
  number: number,
  etag?: string | null,
): Promise<PullCheck> {
  const result = await githubGetConditional<RawPull>(token, `/repos/${repo}/pulls/${number}`, etag);
  if (!result.changed) return result;
  return {
    changed: true,
    state: pullState(result.data),
    etag: result.etag,
    number: result.data.number ?? number,
    headSha: result.data.head?.sha ?? null,
  };
}

/** The pull request's state and head right now, unconditionally. */
export async function getPull(token: string, repo: string, number: number) {
  const pull = await githubGet<RawPull>(token, `/repos/${repo}/pulls/${number}`);
  return { state: pullState(pull), headSha: pull.head?.sha ?? null };
}

/** Reopens a pull request closed without merging. */
export async function reopenPull(token: string, repo: string, number: number) {
  await githubSend(token, `/repos/${repo}/pulls/${number}`, "PATCH", { state: "open" });
}

// What a pull request's reviewers and checks said. Each list is conditional
// and asks for the newest hundred, which is all a Kru pull request gets.

export function listPullReviews<T>(token: string, repo: string, number: number, etag?: string | null) {
  return githubGetConditional<T[]>(token, `/repos/${repo}/pulls/${number}/reviews?per_page=100`, etag);
}

export function listPullReviewComments<T>(token: string, repo: string, number: number, etag?: string | null) {
  return githubGetConditional<T[]>(
    token,
    `/repos/${repo}/pulls/${number}/comments?per_page=100&sort=updated&direction=desc`,
    etag,
  );
}

export function listIssueComments<T>(token: string, repo: string, number: number, etag?: string | null) {
  return githubGetConditional<T[]>(
    token,
    `/repos/${repo}/issues/${number}/comments?per_page=100&sort=updated&direction=desc`,
    etag,
  );
}

/** Needs `checks: read`; a `GithubPermissionError` means the app lacks it. */
export async function listCheckRuns<T>(token: string, repo: string, sha: string, etag?: string | null) {
  const result = await githubGetConditional<{ check_runs?: T[] }>(
    token,
    `/repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
    etag,
  );
  if (!result.changed) return result;
  return { changed: true as const, data: result.data.check_runs ?? [], etag: result.etag };
}

export async function listCheckRunAnnotations<T>(token: string, repo: string, checkRunId: number, limit = 20) {
  return githubGet<T[]>(token, `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=${limit}`);
}

/**
 * Open issues carrying `label`, updated since `since`, conditionally.
 * Pull requests come back too (GitHub counts them as issues); the caller
 * drops them. Needs `issues: read`.
 */
export function listLabelledIssues<T>(
  token: string,
  repo: string,
  label: string,
  since: string | null,
  etag?: string | null,
) {
  const params = new URLSearchParams({ labels: label, state: "open", sort: "updated", direction: "asc", per_page: "50" });
  if (since) params.set("since", since);
  return githubGetConditional<T[]>(token, `/repos/${repo}/issues?${params}`, etag);
}

export function getIssue<T>(token: string, repo: string, number: number) {
  return githubGet<T>(token, `/repos/${repo}/issues/${number}`);
}

/**
 * A comment on a pull request's conversation, or on an issue. For a pull
 * request `pull_requests: write` covers it; an issue needs `issues: write`.
 */
export async function postIssueComment(token: string, repo: string, number: number, body: string) {
  await githubSend(token, `/repos/${repo}/issues/${number}/comments`, "POST", { body });
}

type TreeEntry = { path: string; mode: string; type: string };

type Write = { path: string; content: string; deleted?: boolean };

/**
 * One commit holding every write, on top of `parentSha`. The Git Data API
 * builds it in a handful of calls however many files changed: read the
 * parent's tree, write a new tree, commit it. Returns the commit's sha; the
 * caller points a branch at it.
 */
async function commitWrites(token: string, repo: string, parentSha: string, message: string, writes: Write[]) {
  const parent = await githubGet<{ tree: { sha: string } }>(token, `/repos/${repo}/git/commits/${parentSha}`);

  // Existing paths and modes, so deletions of missing files are skipped and
  // executables or symlinks keep their mode.
  const baseTree = await githubGet<{ tree: TreeEntry[]; truncated?: boolean }>(
    token,
    `/repos/${repo}/git/trees/${parent.tree.sha}?recursive=1`,
  );
  const known = new Map<string, TreeEntry>();
  for (const entry of baseTree.tree ?? []) known.set(entry.path, entry);
  const existsOnBase = async (path: string) => {
    if (known.has(path)) return true;
    if (!baseTree.truncated) return false;
    try {
      await githubGet(token, `/repos/${repo}/contents/${encodeURI(path)}?ref=${parentSha}`);
      return true;
    } catch {
      return false;
    }
  };

  const tree: Record<string, unknown>[] = [];
  for (const write of writes) {
    if (write.deleted) {
      // Already gone on the base branch; nothing to remove.
      if (!(await existsOnBase(write.path))) continue;
      tree.push({ path: write.path, mode: known.get(write.path)?.mode ?? "100644", type: "blob", sha: null });
      continue;
    }
    const existing = known.get(write.path);
    const mode = existing?.type === "blob" ? existing.mode : "100644";
    tree.push({ path: write.path, mode, type: "blob", content: write.content });
  }
  if (tree.length === 0) throw new Error("There are no changes to commit");

  const newTree = (await githubSend(token, `/repos/${repo}/git/trees`, "POST", {
    base_tree: parent.tree.sha,
    tree,
  })) as { sha: string };
  const commit = (await githubSend(token, `/repos/${repo}/git/commits`, "POST", {
    message,
    tree: newTree.sha,
    parents: [parentSha],
  })) as { sha: string };
  return commit.sha;
}

async function branchHead(token: string, repo: string, branch: string) {
  const ref = await githubGet<{ object: { sha: string } }>(token, `/repos/${repo}/git/ref/heads/${encodeURI(branch)}`);
  return ref.object.sha;
}

export type AppliedWrites = { url: string; number: number; headSha: string };

/**
 * Applies a card's changes as one commit on a new branch and opens the pull
 * request.
 */
export async function applyWrites(options: {
  token: string;
  repo: string;
  /** Base branch the pull request targets. */
  branch: string;
  /** New branch to push the changes to. */
  head: string;
  title: string;
  body: string;
  /** Message for the single commit that carries every write. */
  message: string;
  writes: Write[];
}): Promise<AppliedWrites> {
  const [owner, name] = options.repo.split("/");
  if (!owner || !name) throw new Error("Invalid repo");
  const { token, repo, head } = options;
  const baseSha = await branchHead(token, repo, options.branch);
  const sha = await commitWrites(token, repo, baseSha, options.message, options.writes);
  await githubSend(token, `/repos/${repo}/git/refs`, "POST", { ref: `refs/heads/${head}`, sha });

  const pr = (await githubSend(token, `/repos/${repo}/pulls`, "POST", {
    title: options.title,
    head,
    base: options.branch,
    body: options.body,
  })) as { html_url: string; number: number };
  return { url: pr.html_url, number: pr.number, headSha: sha };
}

/**
 * Adds one commit to a branch Kru already pushed: a follow-up on its pull
 * request. The commit sits on the branch's current head, so anything pushed
 * there by hand in between stays; `expectedHeadSha` is what Kru last knew,
 * and a mismatch is reported through `warn` rather than refused, since the
 * writes are whole files and land the same either way.
 */
export async function pushWrites(options: {
  token: string;
  repo: string;
  head: string;
  message: string;
  writes: Write[];
  expectedHeadSha?: string | null;
  warn?: (line: string) => void;
}): Promise<{ sha: string }> {
  const { token, repo, head } = options;
  const parentSha = await branchHead(token, repo, head);
  if (options.expectedHeadSha && parentSha !== options.expectedHeadSha) {
    options.warn?.(`${head} moved since the last push (${parentSha.slice(0, 7)}); committing on top of it`);
  }
  const sha = await commitWrites(token, repo, parentSha, options.message, options.writes);
  await githubSend(token, `/repos/${repo}/git/refs/heads/${encodeURI(head)}`, "PATCH", { sha, force: false });
  return { sha };
}
