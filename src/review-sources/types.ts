export type PullRequestResponse = {
  number: number;
  title: string;
  body: string | null;
  changed_files: number;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
};
export type PullRequestFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};
