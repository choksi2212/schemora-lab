'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ArrowUpRight,
  Plus,
  Upload,
  FileUp,
  FolderOpen,
  Search,
  ShieldCheck,
  X,
  Archive,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  fileBase64,
  validateFile,
  when,
  type Project,
  type ImportRecord,
  type ProjectPage,
} from '@/lib/api';
import { ErrorNotice, Loading } from './feedback';

export function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [archived, setArchived] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api<ProjectPage>('/projects', { signal });
      if (!Array.isArray(page.items))
        throw new Error(
          'The workspace response has changed. Please refresh after the service is updated.',
        );
      setProjects(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (!signal?.aborted) setError(cause);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api<ProjectPage>('/projects?cursor=' + encodeURIComponent(nextCursor));
      if (!Array.isArray(next.items))
        throw new Error('The next project page could not be read. Please refresh and try again.');
      setProjects((previous) => [
        ...previous,
        ...next.items.filter((item) => !previous.some((existing) => existing.id === item.id)),
      ]);
      setNextCursor(next.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }
  const visible = projects.filter(
    (project) =>
      project.status === (archived ? 'archived' : 'active') &&
      project.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="page dashboard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>
            Good ideas deserve
            <br />a clearer blueprint.
          </h1>
          <p className="lead">
            Bring your hardware conversation.
            <br className="desktop-break" /> Let’s understand what you’re building.
          </p>
        </div>
        <span className="phase-badge">
          01{' '}
          <span>
            CONVERSATION
            <br />
            TO DESIGN
          </span>
        </span>
      </div>
      <section className="import-banner" aria-labelledby="import-title">
        <div className="banner-content">
          <span className="eyebrow">START WITH WHAT YOU HAVE</span>
          <h2 id="import-title">
            Your conversation.
            <br />
            Your next starting point.
          </h2>
          <p>
            Find the parts, connections, and open questions in your existing design. Review every
            proposed fact beside its source.
          </p>
          <button className="button primary" onClick={() => dialog.current?.showModal()}>
            <Upload size={16} /> Import conversation <ArrowRight size={16} />
          </button>
          <span className="format-line">
            TXT · MARKDOWN · HTML · PDF · JSON · ZIP <span>UP TO 10 MB</span>
          </span>
        </div>
        <div className="circuit-art" aria-hidden="true">
          <div className="art-grid" />
          <span className="art-dot dot-one" />
          <span className="art-dot dot-two" />
          <span className="art-dot dot-three" />
          <div className="art-chip">
            <span className="chip-pin pin-left" />
            <span className="chip-pin pin-right" />
            <span className="chip-mark">S</span>
            <span className="chip-label">THOUGHT → FORM</span>
          </div>
          <div className="art-trace trace-one" />
          <div className="art-trace trace-two" />
          <span className="art-coordinate">SCHEMORA / 01</span>
        </div>
      </section>
      <section className="projects-section" aria-labelledby="projects-title">
        <div className="section-heading">
          <h2 id="projects-title">
            Your projects{' '}
            <span className="count">
              {projects.filter((p) => p.status === (archived ? 'archived' : 'active')).length}
            </span>
          </h2>
          <div className="section-actions">
            <button
              className="filter-toggle"
              onClick={() => setArchived(!archived)}
              aria-pressed={archived}
            >
              <Archive size={15} />
              {archived ? 'Show active' : 'Archived'}
            </button>
            <button className="text-button" onClick={() => dialog.current?.showModal()}>
              <Plus size={16} /> New project
            </button>
          </div>
        </div>
        <div className="search-field">
          <Search size={16} />
          <label className="sr-only" htmlFor="project-search">
            Search projects
          </label>
          <input
            id="project-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a project…"
          />
        </div>
        <ErrorNotice error={error} onRetry={() => void load()} />
        {loading ? (
          <Loading />
        ) : !error && visible.length === 0 ? (
          <div className="empty-projects">
            <span className="empty-icon">
              <FolderOpen size={25} />
            </span>
            <h3>
              {query
                ? 'No matching projects'
                : archived
                  ? 'No archived projects'
                  : 'Your first blueprint starts here'}
            </h3>
            <p>
              {query
                ? 'Try a different name.'
                : archived
                  ? 'Archived projects appear here when you set them aside.'
                  : 'Import a conversation to turn your hardware idea into a reviewable design.'}
            </p>
            {!query && !archived && (
              <button className="text-button" onClick={() => dialog.current?.showModal()}>
                Create your first project <ArrowRight size={16} />
              </button>
            )}
          </div>
        ) : (
          <div className="project-grid">
            {visible.map((project) => (
              <Link className="project-card" key={project.id} href={`/projects/${project.id}`}>
                <div className="project-card-top">
                  <span className="project-icon">
                    <FolderOpen size={19} />
                  </span>
                  <ArrowUpRight size={18} />
                </div>
                <span className="status-chip">
                  {project.status === 'archived' ? 'Archived' : 'Design workspace'}
                </span>
                <h3>{project.title}</h3>
                <span className="fine-text">Updated {when(project.updatedAt)}</span>
                <div className="project-card-bottom">
                  <span>Revision {project.revision}</span>
                  <span>Open project →</span>
                </div>
              </Link>
            ))}
          </div>
        )}
        {nextCursor && (
          <button
            className="button secondary load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading more…' : 'Load more projects'}
          </button>
        )}
      </section>
      <div className="trust-strip">
        <ShieldCheck size={17} />
        <span>Proposed facts stay unverified until you review them.</span>
        <span className="trust-extra">Clarity before confidence.</span>
      </div>
      <dialog ref={dialog} className="import-dialog" aria-labelledby="new-project-title">
        <NewProject
          onClose={() => dialog.current?.close()}
          onCreated={(id) => {
            dialog.current?.close();
            router.push(`/projects/${id}`);
          }}
        />
      </dialog>
    </div>
  );
}

function NewProject({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [step, setStep] = useState('');
  const [created, setCreated] = useState<Project | null>(null);
  const retryKey = useRef<string | null>(null);
  const uploadKey = useRef<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      setError(new Error('Enter a project name.'));
      return;
    }
    if (file) {
      const invalid = validateFile(file);
      if (invalid) {
        setError(new Error(invalid));
        return;
      }
    }
    setError(null);
    setBusy(true);
    try {
      setStep('Creating your workspace…');
      const project =
        created ??
        (await api<Project>('/projects', {
          method: 'POST',
          body: { title: title.trim() },
          idempotencyKey: retryKey.current ?? (retryKey.current = crypto.randomUUID()),
        }));
      setCreated(project);
      if (file) {
        setStep('Uploading your conversation…');
        await api<{ project: Project; import: ImportRecord }>(`/projects/${project.id}/imports`, {
          method: 'POST',
          body: {
            expectedRevision: project.revision,
            filename: file.name,
            contentBase64: await fileBase64(file),
          },
          idempotencyKey: uploadKey.current ?? (uploadKey.current = crypto.randomUUID()),
        });
      }
      onCreated(project.id);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">NEW WORKSPACE</span>
          <h2 id="new-project-title">Start your blueprint.</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close new project"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <p className="muted-copy">
        Name your project and add a conversation export. You can also start with an empty workspace.
      </p>
      <label className="field-label" htmlFor="new-title">
        Project name
      </label>
      <input
        id="new-title"
        className="text-input"
        maxLength={160}
        required
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          retryKey.current = null;
        }}
        placeholder="e.g. ESP32 desk light"
        disabled={busy || !!created}
        autoFocus
      />
      <label className="upload-zone" htmlFor="new-file">
        <FileUp size={27} />
        <strong>{file?.name ?? 'Choose your conversation export'}</strong>
        <span>
          {file
            ? `${(file.size / 1024).toFixed(1)} KB · Select to replace`
            : 'TXT, MD, HTML, PDF, JSON, ZIP · up to 10 MB'}
        </span>
        <input
          id="new-file"
          className="sr-only"
          type="file"
          accept=".txt,.md,.html,.pdf,.json,.zip"
          disabled={busy}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (!selected) return;
            const invalid = validateFile(selected);
            if (invalid) {
              setError(new Error(invalid));
              event.target.value = '';
              return;
            }
            setFile(selected);
            uploadKey.current = null;
            setError(null);
            if (!title) setTitle(selected.name.replace(/\.[^.]+$/, ''));
          }}
        />
      </label>
      {file && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            setFile(null);
            uploadKey.current = null;
          }}
        >
          Remove selected file
        </button>
      )}
      <p className="fine-text">
        Conversation text is displayed as source material. Extraction proposes facts; it does not
        verify electrical behavior.
      </p>
      <ErrorNotice error={error} />
      {created && !!error && (
        <p className="fine-text">
          Your project was created. You can retry the upload or{' '}
          <button
            type="button"
            className="text-button inline"
            onClick={() => onCreated(created.id)}
          >
            open the workspace
          </button>
          .
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? step : file ? 'Create & import' : 'Create project'}{' '}
          {!busy && <ArrowRight size={16} />}
        </button>
      </div>
    </form>
  );
}
