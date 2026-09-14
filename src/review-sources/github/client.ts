const GITHUB_API_BASE = "https://api.github.com";
export type GithubRequester = <T>(
  path: string,
  signal?: AbortSignal,
) => Promise<T>;
export const githubRequest: GithubRequester = async <T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    signal: signal ?? AbortSignal.timeout(60000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    throw new Error(
      `GitHub API error ${response.status}${remaining === "0" ? ` (rate limited until ${reset ?? "unknown"})` : ""}: ${text.slice(0, 500)}`,
    );
  }
  return response.json() as Promise<T>;
};
