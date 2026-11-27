export type Fact = { id: string; project: string; source: string; claim: string; confirmed: boolean; allowDrafts: boolean; allowLive: boolean; origin: string };
export type Probe = { name: string; question: string; anchor: string; drill: string };
type Mark = { points: number; quote: string; feedback: string };
type Report = { assessor: "local" | "azure" | "self" | "wording-v1"; marks: Mark[]; score: number; grade: string; verdict: string; retryIndex: number };
export const assessorName = (name: string | null) => name === "self" ? "self-assessed" : name === "local" ? "local model" : name === "azure" ? "Azure OpenAI" : "offline wording screen";
export type Mock = { id: string; target: string; targetId: string | null; chatSession: boolean; rubric: string; startedAt: string; completedAt: string | null; tailored: boolean; adaptive: boolean; questions: string[]; answers: string[]; report: Report | null; retry: string | null };
export type Workspace = { facts: Fact[]; mocks: Mock[]; probes: Probe[]; localCoachEnabled: boolean; privateTest?: boolean };
export type ChatKind = "chat" | "builder" | "mock" | "scout" | "plan";
export type ChatSession = { id: string; kind: ChatKind | "import"; title: string; state: string; revision: number; stage: string; updatedAt: string; targetId: string | null; digestId: string | null };
export type Act = (action: () => Promise<void>) => Promise<void>;
export class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

async function request(path: string, method: string, input?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}) {
  if (method !== "GET") headers["X-Practice-Request"] = "1";
  if (input !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`/api/${path}`, { method, headers, body: JSON.stringify(input), cache: "no-store", signal });
  if (!response.ok) {
    const reason = await response.json().catch(() => null);
    throw new RequestError(response.status,typeof reason === "string" ? reason : response.status === 401
      ? "No active local workspace in this browser. Return home to open one."
      : `Could not complete this request (${response.status}). Reload before trying again.`);
  }
  return response;
}

export async function api<T = void>(path: string, method = "GET", input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request(path, method, input, signal);
  return response.status === 204 ? undefined as T : response.json();
}

export async function streamTurn(id: string, input: unknown, signal: AbortSignal, onDelta: (text: string) => void) {
  const response = await request(`chats/${id}/turns`, "POST", input, signal, { Accept: "application/x-ndjson" });
  const interrupted = () => Error("The reply was interrupted. Try sending your message again.");
  if (!response.body) throw interrupted();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw interrupted();
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        let event;
        try { event = JSON.parse(buffer.slice(0, end)); } catch { throw interrupted(); }
        buffer = buffer.slice(end + 1);
        if (!event) throw interrupted();
        if (event.type === "delta" && typeof event.text === "string") onDelta(event.text);
        else if (event.type === "done" && typeof event.id === "string" && typeof event.text === "string")
          return { id: event.id as string, text: event.text as string };
        else if (event.type === "error" && typeof event.status === "number" && typeof event.message === "string")
          throw new RequestError(event.status, event.message);
        else throw interrupted();
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function values(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries());
}
