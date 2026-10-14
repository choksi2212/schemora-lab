'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Boxes, FileText, ArrowUpRight, Layers3, CircleHelp, Cpu, BookOpen } from 'lucide-react';
import { useEffect, useState } from 'react';

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const [help, setHelp] = useState(false);
  const [session, setSession] = useState<{
    authenticated: boolean;
    mode?: string;
    user?: { name: string };
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/session', { signal: controller.signal })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Main navigation">
        <Link href="/" className="brand">
          <span className="brand-symbol">
            <Layers3 size={22} />
          </span>
          <span>
            Schemora<span className="brand-sub">HARDWARE LAB</span>
          </span>
        </Link>
        <span className="nav-section">WORKSPACE</span>
        <Link
          className={`nav-item ${pathname === '/' || pathname.startsWith('/projects') ? 'active' : ''}`}
          href="/"
        >
          <Boxes size={18} /> Projects <span className="nav-key">01</span>
        </Link>
        <Link
          className={`nav-item ${pathname.startsWith('/catalog') ? 'active' : ''}`}
          href="/catalog"
        >
          <BookOpen size={18} /> Hardware catalog <span className="nav-key">02</span>
        </Link>
        {projectId ? (
          <Link
            className={`nav-item ${pathname.endsWith('/circuit') ? 'active' : ''}`}
            href={`/projects/${projectId}/circuit`}
          >
            <Cpu size={18} /> 3D workbench <span className="nav-key">03</span>
          </Link>
        ) : (
          <div className="nav-item muted" title="Open a project to use its circuit workbench">
            <Cpu size={18} /> 3D workbench <span className="tiny-tag">Open project</span>
          </div>
        )}
        <div className="sidebar-note">
          <span className="eyebrow">DESIGN WITH CONTEXT</span>
          <p>Every connection starts with understanding.</p>
          <span className="fine-text">Import → Review → Build</span>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setHelp(!help)} aria-expanded={help}>
            <CircleHelp size={18} /> How it works
          </button>
          {help && (
            <div className="help-panel">
              Import your conversation, review each proposal beside its source, then open a
              project's circuit workspace to edit exact terminals and inspect its illustrative 3D
              view. Deterministic checks preserve unknown electrical limits; they do not certify fit
              or physical safety.
            </div>
          )}
          <Link className="nav-item" href="/account">
            <FileText size={18} /> Account <ArrowUpRight size={15} />
          </Link>
          <span className="sidebar-version">SCHEMORA · PHASE 03</span>
        </div>
      </aside>
      <div className="content-shell">
        <header className="topbar">
          <span className="workspace-label">
            <span className="status-dot" /> Personal workspace
          </span>
          <div className="session-controls">
            {session?.mode === 'development' && (
              <span className="dev-badge">Local development session</span>
            )}
            {session?.authenticated && session.mode !== 'development' && (
              <>
                <span className="fine-text">{session.user?.name}</span>
                <form action="/api/auth/signout" method="post">
                  <button className="text-button">Sign out</button>
                </form>
              </>
            )}
            <span className="topbar-label">From thought to form</span>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="app-footer">
          Built for careful, curious makers.<span>Source-backed. Human-reviewed.</span>
        </footer>
      </div>
    </div>
  );
}
