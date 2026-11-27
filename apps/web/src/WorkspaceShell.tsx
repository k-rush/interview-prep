import { useEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { Brand, Icon, chatUrl, type IconName } from "./CareerUI";
import type { ChatSession } from "./client";

const tools: { page: string; label: string; icon: IconName }[] = [
  { page: "library", label: "Job experience", icon: "builder" },
  { page: "memory", label: "Agent memory", icon: "history" },
  { page: "prep", label: "Schedule", icon: "plan" }
];
const pageNames: Record<string, string> = {
  chat: "Job search coach", new: "Job search coach", history: "Chat history", archive: "Earlier conversation",
  live: "Live reminders", account: "Account", debrief: "Mock debrief", jobs: "Saved job searches"
};
type Navigation = { page: string; chatId?: string; sessions: ChatSession[] | null; listError: string; onNewChat: MouseEventHandler<HTMLAnchorElement> };

function Sidebar({ page, chatId, sessions, listError, onNewChat, close }: Navigation & { close?: () => void }) {
  const current = (active: boolean) => active ? "page" as const : undefined;
  return <div className="rail" onClick={e => { if ((e.target as Element).closest("a")) close?.(); }}>
    <div className="rail-brand"><Brand href="#workspace"/>{close && <button className="icon-button" type="button"
      aria-label="Close navigation" onClick={close}><Icon name="close"/></button>}</div>
    <div className="rail-scroll">
      <nav className="rail-actions" aria-label="Chat actions">
        <a className="rail-link new-chat" href="#workspace" onClick={onNewChat} aria-current={current(page === "chat" && !chatId)}><Icon name="newChat"/>New chat</a>
        <a className="rail-link" href="#workspace/history" aria-current={current(page === "history" || page === "archive")}><Icon name="search"/>Search chats</a>
      </nav>
      <nav className="rail-group" aria-label="Workspace sections"><h2 className="group-label">Job search tools</h2>
        {tools.map(t => <a key={t.page} className="rail-link" href={`#workspace/${t.page}`}
          aria-current={current(page === t.page || t.page === "prep" && page === "live")}><Icon name={t.icon}/>{t.label}</a>)}
      </nav>
      {page !== "live" && <nav className="rail-group recent-chats" aria-label="Recent chats"><h2 className="group-label">Recent chats</h2>
        {listError ? <p className="rail-note">Chat list unavailable. <a href="#workspace/history">Open history</a></p> :
          sessions?.length ? sessions.slice(0, 8).map(s => <a className="rail-link" key={s.id} href={chatUrl(s.id)}
            title={s.title} aria-current={current(s.id === chatId)}><Icon name="chat"/><span>{s.title}</span></a>) :
          <p className="rail-note">{sessions ? "Your conversations will appear here." : "Loading conversations..."}</p>}
        {sessions && sessions.length > 8 && <a className="all-chats" href="#workspace/history">View all conversations <Icon name="arrow"/></a>}
      </nav>}
    </div>
    <a className="rail-account" href="#workspace/account" aria-current={current(page === "account")}>
      <span className="account-icon"><Icon name="account"/></span><span><strong>Account</strong><small>Settings &amp; privacy</small></span><Icon name="chevron"/></a>
  </div>;
}

export function WorkspaceShell({ page, chatId, sessions, listError, onNewChat, routeId, localAI, privateTest, inChat, children }: Navigation & {
  routeId?: string; localAI: boolean; privateTest?: boolean; inChat: boolean; children: ReactNode;
}) {
  const drawer = useRef<HTMLDialogElement>(null), main = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => drawer.current?.close();
  useEffect(() => { if (open && !drawer.current?.open) drawer.current?.showModal(); }, [open]);
  useEffect(() => {
    const desktop = matchMedia("(min-width: 52rem)");
    const resize = () => { if (desktop.matches) drawer.current?.close(); };
    desktop.addEventListener("change", resize);
    return () => desktop.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    drawer.current?.close();
    main.current?.scrollTo(0, 0);
    const field = page === "history" ? "input[type=search]" : page === "chat" && !routeId && matchMedia("(pointer: fine)").matches ? "textarea" : null;
    const target = field && main.current?.querySelector<HTMLElement>(field) || main.current;
    target?.focus({ preventScroll: true });
  }, [page, routeId]);
  const nav = { page, chatId, sessions, listError, onNewChat };
  const title = tools.find(t => t.page === page)?.label ?? pageNames[page] ?? (inChat ? "Job search coach" : "Practice round");
  return <div className="studio"><a className="skip-link" href="#workspace-main" onClick={e => {
    e.preventDefault(); main.current?.focus();
  }}>Skip to content</a>
    <aside className="desktop-rail"><Sidebar {...nav}/></aside>
    <div className="workbench"><header className="workspace-bar">
      <button className="icon-button mobile-control" type="button" aria-label="Open navigation" aria-expanded={open}
        aria-controls="workspace-menu" onClick={() => setOpen(true)}><Icon name="panel"/></button>
      <div className="breadcrumb"><span>Workspace</span><i aria-hidden="true">/</i><strong>{title}</strong></div>
      <span className="engine"><span aria-hidden="true"/>{privateTest ? "Azure OpenAI · fictional data only" : localAI ? "Local AI" : "Offline guide"}</span>
      <a className="icon-button mobile-control" href="#workspace" onClick={onNewChat} aria-label="New chat"><Icon name="newChat"/></a>
    </header>
    <main id="workspace-main" tabIndex={-1} ref={main} className={inChat ? "workspace-main chat-main" : "workspace-main"}>
      {inChat ? children : <div className="page-content">{children}</div>}
    </main></div>
    <dialog ref={drawer} id="workspace-menu" className="nav-drawer" aria-label="Workspace navigation"
      onClose={() => setOpen(false)} onClick={e => { if (e.target === e.currentTarget) close(); }}>
      {open && <Sidebar {...nav} close={close}/>}
    </dialog>
  </div>;
}
