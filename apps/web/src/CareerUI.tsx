import type { ChatSession } from "./client";

const paths = {
  scout: "M3 8h18v12H3z M8 8V5h8v3 M3 12q9 5 18 0 M10 14h4",
  builder: "M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6",
  mock: "M3 4h14v11H8l-5 4z M8 8h5 M20 9h1v12l-4-3h-5",
  plan: "M4 6h16v15H4z M8 3v5 M16 3v5 M4 11h16 M8 15h3",
  newChat: "M12 5H5v15h15v-7 M11 14l1-4 7-7 3 3-7 7z",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l5 5",
  chat: "M4 5h16v12H9l-5 4z",
  account: "M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0 M5 20v-2a7 5 0 0 1 14 0v2",
  panel: "M3 4h18v16H3z M9 4v16",
  close: "M6 6l12 12 M18 6 6 18",
  arrow: "M4 12h15 M13 6l6 6-6 6",
  send: "M12 20V4 M5 11l7-7 7 7",
  attach: "M8 14l7-7a2.1 2.1 0 0 1 3 3l-9 9a4.2 4.2 0 0 1-6-6l10-10a3 3 0 0 1 4.3 0",
  mic: "M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M9 22h6",
  lock: "M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3",
  chevron: "M9 5l7 7-7 7",
  history: "M3 5v5h5 M4 9a8 8 0 1 1 0 7 M12 7v5l3 2",
  upload: "M12 15V3 M7 8l5-5 5 5 M4 15v5h16v-5"
};
export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}

export function Compass() {
  return <span className="compass" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none">
    <path d="M30 9 23 24 10 31l7-15z" fill="currentColor"/><path d="m10 31 7-15 6 8z" fill="#91b7a6"/>
    <circle cx="20" cy="20" r="2" fill="#234b3e"/>
  </svg></span>;
}

export function Brand({ href }: { href: string }) {
  return <a className="brand" href={href}><Compass/><span>Interview Prep</span></a>;
}

export const starts = [
  { slug: "builder", icon: "builder", text: "Help me add experience to my job history." },
  { slug: "practice", icon: "mock", text: "Go through an example interview question with me." },
  { slug: "scout", icon: "scout", text: "Find jobs that are a close match for my experience." },
  { slug: "plan", icon: "plan", text: "Help me plan for an upcoming interview." }
] as const;
export const modeName = (kind: ChatSession["kind"]) => kind === "mock" ? "Mock interview" : kind === "import" ? "Document import" : "Conversation";
export const modeIcon = (kind: ChatSession["kind"]) => kind === "mock" ? "mock" : kind === "import" ? "builder" : "chat";
export const chatUrl = (id: string) => `#workspace/chat/${id}`;

export function StarterLabel({ icon, text }: typeof starts[number]) {
  return <><span className={`intent-icon ${icon}`}><Icon name={icon}/></span>
    <span className="intent-copy"><strong>{text}</strong></span><Icon name="chevron"/></>;
}
