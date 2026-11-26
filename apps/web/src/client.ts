export type Fact = { id: string; project: string; source: string; claim: string; confirmed: boolean };
export type Probe = { name: string; question: string; anchor: string; drill: string };
type Mark = { points: number; quote: string; feedback: string };
type Report = { assessor: "local" | "self"; marks: Mark[]; score: number; grade: string; verdict: string; retryIndex: number };
export type Mock = { id: string; target: string; rubric: string; startedAt: string; tailored: boolean; questions: string[]; answers: string[]; report: Report | null; retry: string | null };
export type Workspace = { facts: Fact[]; mocks: Mock[]; probes: Probe[]; localCoachEnabled: boolean };
export type Act = (action: () => Promise<void>) => Promise<void>;

export async function api<T = void>(path: string, method = "GET", input?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-Practice-Request"] = "1";
  if (input !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`/api/${path}`, { method, headers, body: JSON.stringify(input), cache: "no-store" });
  if (!response.ok) {
    const reason = await response.json().catch(() => null);
    throw new Error(typeof reason === "string" ? reason : response.status === 401
      ? "No active local workspace in this browser. Return home to open one."
      : `Could not complete this request (${response.status}). Reload before trying again.`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function values(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries());
}
