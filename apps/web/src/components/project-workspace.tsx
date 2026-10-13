'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Upload,
  Clock3,
  MoreHorizontal,
  Archive,
  Trash2,
  ArrowRight,
  RefreshCw,
  X,
  FileText,
  Check,
  AlertTriangle,
  Search,
  Quote,
  Pencil,
  GitBranch,
  CircleHelp,
} from 'lucide-react';
import type { Candidate, Evidence, NormalizedMessage } from '@schemora/contracts';
import {
  api,
  fileBase64,
  validateFile,
  when,
  type Project,
  type ProjectDetail,
  type ImportDetail,
  type ImportRecord,
  type Review,
  type Revision,
} from '@/lib/api';
import { ErrorNotice, Loading, SaveState } from './feedback';

type MutationResult = { project: Project; import?: ImportRecord; review?: Review };
const statusLabel: Record<ImportRecord['status'], string> = {
  queued: 'Waiting to process',
  processing: 'Reading & extracting',
  awaiting_selection: 'Choose a conversation',
  ready: 'Ready for review',
  failed: 'Import needs attention',
  cancelled: 'Import cancelled',
};

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [current, setCurrent] = useState<ImportDetail | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [history, setHistory] = useState<Revision[] | null>(null);
  const [menu, setMenu] = useState(false);
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api<ProjectDetail>(`/projects/${projectId}`, { signal });
        if (signal?.aborted) return;
        setDetail(next);
        setImportId((previous) =>
          previous && next.imports.some((item) => item.id === previous)
            ? previous
            : (next.imports[0]?.id ?? null),
        );
        setError(null);
      } catch (cause) {
        if (!signal?.aborted) setError(cause);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const refreshImport = useCallback(
    async (signal?: AbortSignal) => {
      if (!importId) return;
      const next = await api<ImportDetail>(`/projects/${projectId}/imports/${importId}`, {
        signal,
      });
      if (signal?.aborted) return;
      setCurrent(next);
      setDetail((previous) =>
        previous
          ? {
              ...previous,
              project: next.project,
              imports: previous.imports.map((item) =>
                item.id === next.import.id ? next.import : item,
              ),
              reviews: next.reviews,
            }
          : previous,
      );
    },
    [projectId, importId],
  );
  useEffect(() => {
    if (!importId) {
      setCurrent(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCurrent((previous) => (previous?.import.id === importId ? previous : null));
    async function poll() {
      try {
        const next = await api<ImportDetail>(`/projects/${projectId}/imports/${importId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setCurrent(next);
        setDetail((previous) =>
          previous
            ? {
                ...previous,
                project: next.project,
                imports: previous.imports.map((item) =>
                  item.id === next.import.id ? next.import : item,
                ),
                reviews: next.reviews,
              }
            : previous,
        );
        if (next.import.status === 'queued' || next.import.status === 'processing')
          timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      }
    }
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, importId, pollEpoch]);
  useEffect(() => {
    setSelectedEvidence(null);
  }, [importId]);

  async function mutate(path: string, body: Record<string, unknown>, method = 'POST') {
    if (!detail || busy) return false;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api<MutationResult>(`/projects/${projectId}${path}`, {
        method,
        body: { ...body, expectedRevision: detail.project.revision },
      });
      if (method === 'DELETE') {
        router.push('/');
        return true;
      }
      setDetail((previous) => (previous ? { ...previous, project: result.project } : previous));
      await load();
      if (importId) await refreshImport();
      setPollEpoch((previous) => previous + 1);
      setHistory(null);
      setSaved(true);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !detail || busy) return;
    const invalid = validateFile(file);
    if (invalid) {
      setUploadError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<MutationResult>(`/projects/${projectId}/imports`, {
        method: 'POST',
        body: {
          expectedRevision: detail.project.revision,
          filename: file.name,
          contentBase64: await fileBase64(file),
        },
      });
      setFile(null);
      setDetail((previous) =>
        previous
          ? {
              ...previous,
              project: result.project,
              imports: result.import ? [result.import, ...previous.imports] : previous.imports,
            }
          : previous,
      );
      if (result.import) setImportId(result.import.id);
      setSaved(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function showHistory() {
    try {
      setHistory(await api<Revision[]>(`/projects/${projectId}/revisions`));
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  }
  async function loadSnapshot(revision: number) {
    try {
      const snapshot = await api<Revision>(`/projects/${projectId}/revisions/${revision}`);
      setHistory(
        (previous) =>
          previous?.map((item) =>
            item.revision === revision ? { ...item, snapshot: snapshot.snapshot } : item,
          ) ?? null,
      );
    } catch (cause) {
      setError(cause);
    }
  }
  async function loadMessages(evidence?: Evidence) {
    if (!current || !importId || loadingMessages) return;
    setLoadingMessages(true);
    try {
      let messages = current.messages;
      let offset = current.nextMessageSequence;
      while (
        offset !== null &&
        (!evidence || !messages.some((message) => message.id === evidence.messageId))
      ) {
        const next = await api<ImportDetail>(
          `/projects/${projectId}/imports/${importId}?messageOffset=${offset}`,
        );
        messages = [
          ...messages,
          ...next.messages.filter(
            (message) => !messages.some((existing) => existing.id === message.id),
          ),
        ];
        if (next.nextMessageSequence === offset)
          throw new Error(
            'We could not load the next source messages. Please refresh and try again.',
          );
        offset = next.nextMessageSequence;
        if (!evidence) break;
      }
      setCurrent((previous) =>
        previous?.import.id === importId
          ? { ...previous, messages, nextMessageSequence: offset }
          : previous,
      );
      if (evidence) setSelectedEvidence(evidence);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMessages(false);
    }
  }
  function selectEvidence(evidence: Evidence) {
    if (current?.messages.some((message) => message.id === evidence.messageId))
      setSelectedEvidence(evidence);
    else void loadMessages(evidence);
  }
  if (loading)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (!detail)
    return (
      <div className="page">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> Back to projects
        </Link>
        <ErrorNotice error={error} onRetry={() => void load()} />
      </div>
    );
  const project = detail.project;
  const activeImport = current?.import;
  const editable = project.status === 'active';
  return (
    <div className="page workspace-page">
      <Link className="back-link" href="/">
        <ArrowLeft size={15} /> All projects
      </Link>
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">DESIGN WORKSPACE · REVISION {project.revision}</span>
          {rename ? (
            <form
              className="rename-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (await mutate('', { title: title.trim() }, 'PATCH')) setRename(false);
              }}
            >
              <label className="sr-only" htmlFor="rename-title">
                Project name
              </label>
              <input
                className="text-input"
                id="rename-title"
                autoFocus
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <button className="button primary" disabled={busy}>
                Save name
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel rename"
                onClick={() => setRename(false)}
              >
                <X size={18} />
              </button>
            </form>
          ) : (
            <h1>{project.title}</h1>
          )}
        </div>
        <div className="workspace-actions">
          <SaveState busy={busy} saved={saved} />
          <button className="button secondary" onClick={() => void showHistory()}>
            <Clock3 size={16} /> History
          </button>
          <div className="menu-wrap">
            <button
              className="icon-button bordered"
              aria-expanded={menu}
              aria-label="Project actions"
              onClick={() => setMenu(!menu)}
            >
              <MoreHorizontal size={20} />
            </button>
            {menu && (
              <div className="action-menu">
                <button
                  disabled={!editable || busy}
                  onClick={() => {
                    setTitle(project.title);
                    setRename(true);
                    setMenu(false);
                  }}
                >
                  <Pencil size={15} /> Rename project
                </button>
                <button
                  disabled={!editable || busy}
                  onClick={() => {
                    void mutate('/archive', {});
                    setMenu(false);
                  }}
                >
                  <Archive size={15} /> Archive project
                </button>
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() => {
                    deleteDialog.current?.showModal();
                    setMenu(false);
                  }}
                >
                  <Trash2 size={15} /> Delete project
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="journey-strip">
        <span className="journey-step complete">
          <Check size={14} /> Project
        </span>
        <span className={`journey-step ${activeImport ? 'complete' : 'current'}`}>
          02 Import conversation
        </span>
        <span className={`journey-step ${activeImport?.status === 'ready' ? 'current' : ''}`}>
          03 Review design
        </span>
        <span className="journey-step future">
          04 Hardware & build <span>Coming later</span>
        </span>
      </div>
      <section className="panel" aria-labelledby="circuit-workspace-title">
        <div className="panel-heading">
          <div>
            <h2 id="circuit-workspace-title">Hardware knowledge & validation</h2>
            <p className="fine-text">
              Model a source-backed starter circuit and review deterministic checks.
            </p>
          </div>
          <Link className="button secondary" href={`/projects/${projectId}/circuit`}>
            Open circuit workspace <ArrowRight size={15} />
          </Link>
        </div>
      </section>
      <ErrorNotice
        error={error}
        onRetry={() => {
          void load();
          void refreshImport().catch(setError);
        }}
      />
      {!editable && (
        <div className="warning-notice">
          <Archive size={18} />
          <span>This project is archived. You can read its sources and review history.</span>
        </div>
      )}
      {history && (
        <section className="history-panel">
          <div className="section-heading">
            <h2>
              <GitBranch size={18} /> Revision history
            </h2>
            <button
              className="icon-button"
              onClick={() => setHistory(null)}
              aria-label="Close revision history"
            >
              <X size={18} />
            </button>
          </div>
          <p className="fine-text">
            Saved changes are retained as immutable revisions. Restoring revisions is planned for a
            later phase.
          </p>
          <ol>
            {history.map((item) => (
              <li key={item.revision}>
                <span className="revision-number">r{item.revision}</span>
                <span>
                  {item.kind.replaceAll('_', ' ')}
                  <small>{when(item.createdAt)}</small>
                </span>
                <details>
                  <summary
                    onClick={() => {
                      if (item.snapshot === undefined) void loadSnapshot(item.revision);
                    }}
                  >
                    Inspect snapshot
                  </summary>
                  <pre>
                    {item.snapshot === undefined
                      ? 'Loading snapshot…'
                      : JSON.stringify(item.snapshot, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="import-toolbar">
        <div>
          <h2>
            <FileText size={18} /> Source conversations
          </h2>
          <p className="fine-text">Keep the source close to every design decision.</p>
        </div>
        <form className="compact-upload" onSubmit={upload}>
          <label className="button secondary file-picker">
            <Upload size={15} />
            {file ? file.name : 'Add conversation'}
            <input
              className="sr-only"
              type="file"
              accept=".txt,.md,.html,.pdf,.json,.zip"
              disabled={busy || !editable}
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (!selected) return;
                const invalid = validateFile(selected);
                setUploadError(invalid ?? '');
                if (!invalid) setFile(selected);
              }}
            />
          </label>
          {file && (
            <>
              <button className="button primary" disabled={busy || !editable}>
                {busy ? 'Uploading…' : 'Start import'}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Remove selected file"
                onClick={() => setFile(null)}
              >
                <X size={16} />
              </button>
            </>
          )}
        </form>
      </div>
      {uploadError && (
        <p className="field-error" role="alert">
          {uploadError}
        </p>
      )}
      {detail.imports.length > 0 && (
        <label className="source-select">
          Source export
          <select
            value={importId ?? ''}
            onChange={(event) => {
              setImportId(event.target.value);
              setError(null);
            }}
          >
            {detail.imports.map((item) => (
              <option value={item.id} key={item.id}>
                {item.filename} · {statusLabel[item.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {detail.imports.length === 0 ? (
        <div className="empty-projects workspace-empty">
          <span className="empty-icon">
            <Upload size={26} />
          </span>
          <h2>Your source is the starting point.</h2>
          <p>
            Add a conversation export to find proposed parts, connections,
            <br />
            firmware, and questions that still need an answer.
          </p>
          <span className="fine-text">TXT · MARKDOWN · HTML · PDF · JSON · ZIP · UP TO 10 MB</span>
        </div>
      ) : !current ? (
        <Loading label="Opening your source conversation…" />
      ) : (
        activeImport && (
          <>
            <div className={`import-state ${activeImport.status}`} role="status">
              <span className="status-chip">{statusLabel[activeImport.status]}</span>
              <span>{activeImport.filename}</span>
              {(activeImport.status === 'queued' || activeImport.status === 'processing') && (
                <>
                  <span className="fine-text">You can leave this page and return later.</span>
                  <button
                    className="text-button"
                    disabled={busy || !editable}
                    onClick={() => void mutate(`/imports/${activeImport.id}/cancel`, {})}
                  >
                    Cancel processing
                  </button>
                </>
              )}
              {(activeImport.status === 'failed' || activeImport.status === 'cancelled') && (
                <>
                  <p>
                    We couldn’t finish this import.{' '}
                    {activeImport.errorCode ? `Reference: ${activeImport.errorCode}.` : ''} Your
                    project and earlier reviews are still saved.
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy || !editable}
                    onClick={() => void mutate(`/imports/${activeImport.id}/retry`, {})}
                  >
                    <RefreshCw size={15} /> Retry import
                  </button>
                </>
              )}
            </div>
            {activeImport.status === 'awaiting_selection' && (
              <section className="thread-picker">
                <span className="eyebrow">ACCOUNT EXPORT DETECTED</span>
                <h2>Which conversation are you building from?</h2>
                <p>Choose one thread to review. Other threads in this export won’t be extracted.</p>
                <div className="thread-grid">
                  {activeImport.conversations.map((thread) => (
                    <button
                      className="thread-card"
                      key={thread.id}
                      disabled={busy || !editable}
                      onClick={() =>
                        void mutate(`/imports/${activeImport.id}/select`, {
                          conversationId: thread.id,
                        })
                      }
                    >
                      <FileText size={19} />
                      <strong>{thread.title}</strong>
                      <span>{thread.messageCount} messages</span>
                      <ArrowRight size={17} />
                    </button>
                  ))}
                </div>
              </section>
            )}
            {activeImport.warnings?.length > 0 && (
              <div className="warning-notice">
                <AlertTriangle size={17} />
                <div>
                  <strong>Source import notes</strong>
                  <ul>
                    {activeImport.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {activeImport.status === 'ready' && activeImport.extraction && (
              <>
                <div className="review-intro">
                  <div>
                    <span className="eyebrow">UNDERSTAND BEFORE YOU BUILD</span>
                    <h2>Review the proposed design.</h2>
                    <p>{activeImport.extraction.summary}</p>
                  </div>
                  <div className="extraction-label">
                    <CircleHelp size={16} />
                    <span>
                      {activeImport.extractionMode === 'provider'
                        ? 'AI extraction · unverified proposals'
                        : activeImport.extractionMode === 'deterministic'
                          ? 'Deterministic extraction · limited recognition'
                          : 'Extraction mode unavailable · unverified proposals'}
                      <small>
                        Confirmation records your decision. It does not verify hardware.
                      </small>
                    </span>
                  </div>
                </div>
                <div className="review-layout">
                  <Transcript
                    messages={current.messages}
                    evidence={selectedEvidence}
                    hasMore={current.nextMessageSequence !== null}
                    loadingMore={loadingMessages}
                    onLoadMore={() => void loadMessages()}
                  />
                  <DesignReview
                    extraction={activeImport.extraction}
                    reviews={current.reviews}
                    busy={busy || !editable}
                    onEvidence={selectEvidence}
                    onReview={(candidateId, decision, value, reason) =>
                      mutate(`/imports/${activeImport.id}/reviews`, {
                        candidateId,
                        decision,
                        ...(value !== undefined ? { value } : {}),
                        ...(reason ? { reason } : {}),
                      })
                    }
                  />
                </div>
              </>
            )}
          </>
        )
      )}
      <dialog ref={deleteDialog} className="confirm-dialog" aria-labelledby="delete-title">
        <h2 id="delete-title">Delete this project?</h2>
        <p>
          “{project.title}” and its uploaded conversations will be scheduled for deletion. You won’t
          be able to reopen this workspace.
        </p>
        <div className="dialog-actions">
          <button className="button secondary" onClick={() => deleteDialog.current?.close()}>
            Keep project
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={async () => {
              if (await mutate('', {}, 'DELETE')) deleteDialog.current?.close();
            }}
          >
            Delete project
          </button>
        </div>
      </dialog>
    </div>
  );
}

function Transcript({
  messages,
  evidence,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  messages: NormalizedMessage[];
  evidence: Evidence | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [query, setQuery] = useState('');
  const selected = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (evidence) {
      setQuery('');
      requestAnimationFrame(() =>
        selected.current?.scrollIntoView({ behavior: 'instant', block: 'nearest' }),
      );
    }
  }, [evidence]);
  const visible = messages.filter(
    (message) => !query || message.content.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="transcript panel" aria-labelledby="transcript-title">
      <div className="panel-heading">
        <h3 id="transcript-title">Original conversation</h3>
        <span className="fine-text">
          {messages.length} {hasMore ? 'messages loaded' : 'messages'}
        </span>
      </div>
      <div className="search-field">
        <Search size={15} />
        <label className="sr-only" htmlFor="transcript-search">
          {hasMore ? 'Search loaded source messages' : 'Search conversation'}
        </label>
        <input
          id="transcript-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={hasMore ? 'Search loaded source messages…' : 'Search the source…'}
        />
      </div>
      <span className="sr-only" role="status">
        {evidence ? `Source evidence selected: ${evidence.quote.slice(0, 160)}` : ''}
      </span>
      <ol className="messages-list">
        {visible.map((message) => {
          const isSelected = evidence?.messageId === message.id;
          return (
            <li
              className={`message ${isSelected ? 'evidence-selected' : ''}`}
              key={message.id}
              ref={isSelected ? selected : undefined}
              tabIndex={isSelected ? 0 : undefined}
            >
              <div className="message-heading">
                <span className={`speaker ${message.role}`}>
                  {message.role === 'unknown' ? 'Source' : message.role}
                </span>
                <span>
                  #{message.sequence + 1}
                  {message.source.page ? ` · Page ${message.source.page}` : ''}
                </span>
              </div>
              <div className="message-content">
                {isSelected && evidence ? (
                  <>
                    {message.content.slice(0, evidence.start)}
                    <mark>{message.content.slice(evidence.start, evidence.end)}</mark>
                    {message.content.slice(evidence.end)}
                  </>
                ) : (
                  message.content
                )}
              </div>
              {isSelected && evidence && (
                <span className="evidence-caption">
                  <Quote size={12} /> Source evidence for selected fact
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {hasMore && (
        <button className="button secondary load-more" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? 'Loading source…' : 'Load more source messages'}
        </button>
      )}
      {visible.length === 0 && (
        <p className="muted-copy empty-results">No source messages match your search.</p>
      )}
    </section>
  );
}

function DesignReview({
  extraction,
  reviews,
  busy,
  onEvidence,
  onReview,
}: {
  extraction: NonNullable<ImportRecord['extraction']>;
  reviews: Review[];
  busy: boolean;
  onEvidence: (evidence: Evidence) => void;
  onReview: (
    id: string,
    decision: Review['decision'],
    value?: string,
    reason?: string,
  ) => Promise<boolean>;
}) {
  const [kind, setKind] = useState('all');
  const [editing, setEditing] = useState<string | null>(null);
  const candidates = extraction.candidates.filter((item) => kind === 'all' || item.kind === kind);
  const latest = new Map<string, Review>();
  for (const review of reviews)
    if ((latest.get(review.candidateId)?.revision ?? -1) < review.revision)
      latest.set(review.candidateId, review);
  const reviewed = extraction.candidates.filter((item) => latest.has(item.id)).length;
  return (
    <section className="design-review panel" aria-labelledby="design-title">
      <div className="panel-heading">
        <h3 id="design-title">Proposed design</h3>
        <span className="fine-text" role="status">
          {reviewed} / {extraction.candidates.length} reviewed
        </span>
      </div>
      <div className="fact-filters" aria-label="Filter proposed facts">
        {['all', 'board', 'component', 'connection', 'firmware', 'requirement'].map((value) => (
          <button
            key={value}
            className={kind === value ? 'selected' : ''}
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {value === 'all' ? 'All facts' : `${value[0]?.toUpperCase()}${value.slice(1)}`}
          </button>
        ))}
      </div>
      {extraction.conflicts.length > 0 && (
        <section className="conflict-box">
          <h4>
            <AlertTriangle size={15} /> Conflicting claims need your decision
          </h4>
          {extraction.conflicts.map((conflict) => (
            <div key={conflict.id}>
              <p>{conflict.description}</p>
              <div>
                {conflict.candidateIds.map((id) => {
                  const candidate = extraction.candidates.find((item) => item.id === id);
                  return (
                    candidate && (
                      <button
                        key={id}
                        className="text-button"
                        onClick={() => {
                          setKind('all');
                          document
                            .getElementById(`fact-${id}`)
                            ?.scrollIntoView({ block: 'center' });
                        }}
                      >
                        {candidate.value}
                      </button>
                    )
                  );
                })}
              </div>
            </div>
          ))}
          <span className="fine-text">
            Reject or mark an older claim obsolete explicitly. A confirmed claim does not
            automatically settle its alternatives.
          </span>
        </section>
      )}
      <div className="facts-list">
        {candidates.map((candidate) => (
          <FactCard
            key={candidate.id}
            candidate={candidate}
            review={latest.get(candidate.id)}
            busy={busy}
            editing={editing === candidate.id}
            onEdit={() => setEditing(candidate.id)}
            onClose={() => setEditing(null)}
            onEvidence={onEvidence}
            onReview={onReview}
          />
        ))}
        {candidates.length === 0 && (
          <p className="empty-results muted-copy">
            No {kind === 'all' ? 'recognizable facts' : `${kind} facts`} were found. Missing
            information remains unresolved.
          </p>
        )}
      </div>
      <section className="missing-box">
        <h4>
          <CircleHelp size={16} /> Still to clarify
        </h4>
        {extraction.missingInformation.length ? (
          <ul>
            {extraction.missingInformation.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        ) : (
          <p>
            No additional questions were identified. This does not establish that the design is
            complete or electrically correct.
          </p>
        )}
        <p className="fine-text">
          Exact board mapping and circuit validation become available in later phases.
        </p>
      </section>
    </section>
  );
}

function FactCard({
  candidate,
  review,
  busy,
  editing,
  onEdit,
  onClose,
  onEvidence,
  onReview,
}: {
  candidate: Candidate;
  review?: Review;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onEvidence: (evidence: Evidence) => void;
  onReview: (
    id: string,
    decision: Review['decision'],
    value?: string,
    reason?: string,
  ) => Promise<boolean>;
}) {
  const [value, setValue] = useState(review?.value ?? candidate.value);
  const [reason, setReason] = useState('');
  const status = review
    ? (
        {
          accept: 'Confirmed by you',
          correct: 'Corrected by you',
          reject: 'Rejected',
          obsolete: 'Marked obsolete',
        } as const
      )[review.decision]
    : candidate.status === 'superseded'
      ? 'Earlier claim · unreviewed'
      : 'Candidate · unverified';
  return (
    <article
      className={`fact-card ${review ? `review-${review.decision}` : ''}`}
      id={`fact-${candidate.id}`}
    >
      <div className="fact-header">
        <span className="fact-kind">{candidate.kind}</span>
        <span
          className={`status-chip ${review?.decision === 'accept' || review?.decision === 'correct' ? 'confirmed' : ''}`}
        >
          {status}
        </span>
      </div>
      <p className="fact-value">
        {review?.decision === 'correct' ? review.value : candidate.value}
      </p>
      {review?.decision === 'correct' && (
        <p className="fine-text">Original proposal: {candidate.value}</p>
      )}
      {candidate.uncertainty && (
        <p className="fact-uncertainty">
          <AlertTriangle size={13} />
          {candidate.uncertainty}
        </p>
      )}
      <CandidateDetails candidate={candidate} />
      <div className="evidence-links">
        {candidate.evidence.map((evidence, index) => (
          <button
            key={`${evidence.messageId}-${index}`}
            className="evidence-link"
            onClick={() => onEvidence(evidence)}
            title={evidence.quote}
          >
            <Quote size={13} /> Show source {candidate.evidence.length > 1 ? index + 1 : ''}
          </button>
        ))}
      </div>
      {review?.reason && <p className="fine-text">Review note: {review.reason}</p>}
      {editing ? (
        <form
          className="correction-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await onReview(candidate.id, 'correct', value.trim(), reason.trim())) onClose();
          }}
        >
          <label className="field-label" htmlFor={`correct-${candidate.id}`}>
            Your corrected value
          </label>
          <textarea
            id={`correct-${candidate.id}`}
            value={value}
            required
            maxLength={20_000}
            onChange={(event) => setValue(event.target.value)}
          />
          <label className="field-label" htmlFor={`reason-${candidate.id}`}>
            Reason or context <span className="fine-text">(optional)</span>
          </label>
          <input
            id={`reason-${candidate.id}`}
            className="text-input"
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="fact-actions">
            <button className="button primary small" disabled={busy || !value.trim()}>
              Save correction
            </button>
            <button type="button" className="text-button" onClick={onClose}>
              Keep original
            </button>
          </div>
        </form>
      ) : (
        <div className="fact-actions">
          <button
            className="review-button"
            disabled={busy || review?.decision === 'accept' || candidate.status === 'superseded'}
            title={
              candidate.status === 'superseded'
                ? 'This earlier claim was superseded. Correct it or mark it obsolete.'
                : undefined
            }
            onClick={() => void onReview(candidate.id, 'accept')}
          >
            <Check size={14} /> Confirm
          </button>
          <button className="review-button" disabled={busy} onClick={onEdit}>
            <Pencil size={13} /> Correct
          </button>
          <button
            className="review-button"
            disabled={busy || review?.decision === 'reject'}
            onClick={() => void onReview(candidate.id, 'reject')}
          >
            <X size={14} /> Reject
          </button>
          <button
            className="review-button obsolete"
            disabled={busy || review?.decision === 'obsolete'}
            onClick={() => void onReview(candidate.id, 'obsolete')}
          >
            Mark obsolete
          </button>
        </div>
      )}
    </article>
  );
}

function CandidateDetails({ candidate }: { candidate: Candidate }) {
  let rows: [string, string | number | null][] = [];
  if (candidate.kind === 'board')
    rows = [
      ['Manufacturer', candidate.details.manufacturer],
      ['Family', candidate.details.family],
      ['Exact model', candidate.details.exactModel],
      ['Board revision', candidate.details.revision],
    ];
  else if (candidate.kind === 'component')
    rows = [
      ['Component type', candidate.details.type],
      ['Quantity', candidate.details.quantity],
      ['Resistance (Ω)', candidate.details.resistanceOhms],
    ];
  else if (candidate.kind === 'connection')
    rows = [
      ['From endpoint', candidate.details.from?.label ?? null],
      ['From component', candidate.details.from?.componentRef ?? null],
      ['To endpoint', candidate.details.to?.label ?? null],
      ['To component', candidate.details.to?.componentRef ?? null],
    ];
  else if (candidate.kind === 'firmware') rows = [['Language', candidate.details.language]];
  else return null;
  return (
    <details className="candidate-details">
      <summary>Original extraction details</summary>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value ?? 'Unknown · needs review'}</dd>
          </div>
        ))}
      </dl>
      <p className="fine-text">
        These fields describe the original source proposal. Your correction is recorded separately
        above.
      </p>
    </details>
  );
}
