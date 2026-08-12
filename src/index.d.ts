export interface RedirectHop {
  url: string;
  status: number;
}

export interface CheckUrlSuccess {
  url: string;
  status: number;
  urlFinal: string | null;
  chain: RedirectHop[];
  error?: undefined;
}

export interface CheckUrlFailure {
  url: string;
  error: string;
  chain: RedirectHop[];
  status?: undefined;
  urlFinal?: undefined;
}

export type CheckUrlResult = CheckUrlSuccess | CheckUrlFailure;

export interface CheckReady {
  files: string[];
  urls: string[];
}

export interface SkippedDir {
  dir: string;
  err: Error & { code?: string };
}

export interface FindOptions {
  onWarn?: (skipped: SkippedDir) => void;
}

export interface CheckOptions extends FindOptions {
  concurrency?: number;
  onResult?: (result: CheckUrlResult) => void;
  onReady?: (ready: CheckReady) => void;
}

export interface CheckResult {
  dir: string;
  files: string[];
  urls: string[];
  urlToFiles: Map<string, string[]>;
  results: CheckUrlResult[];
}

export declare function findHtaccessFiles(dir: string, options?: FindOptions): Promise<string[]>;

export declare function extractTargets(content: string): Set<string>;

export declare function checkUrl(url: string): Promise<CheckUrlResult>;

export declare function check(dir?: string, options?: CheckOptions): Promise<CheckResult>;