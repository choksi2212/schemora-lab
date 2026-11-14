'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, Cable, Cpu, Layers3, Search, Zap } from 'lucide-react';
import { api, friendlyError } from '@/lib/api';
import { ErrorNotice, Loading } from './feedback';

type Source = {
  id: string;
  url: string;
  publisher: string;
  title: string;
  accessedOn: string;
  documentRevision: string | null;
};
type Part = {
  id: string;
  manufacturer: string;
  model: string;
  category: 'development-board' | 'led' | 'resistor' | 'pushbutton';
  identityScope: string;
  summary: string;
  sourceIds: string[];
  limitations: string[];
  terminals: { id: string; label: string; electricalRole: string }[];
  configuration?: { module: string; header: string };
  moduleOperatingSupplyVolt?: { minimum: number; maximum: number };
  pins?: {
    terminalId: string;
    header: string;
    position: number;
    printedLabel: string;
    functions: string[];
    availableForScenario: boolean;
  }[];
  supplyOptions?: string[];
  package?: string;
  color?: string;
  forwardVoltage?: {
    testCurrentMilliamp: number;
    typicalVolt: number;
    maximumVolt: number;
    toleranceVolt: number;
  };
  maximumDcForwardCurrentMilliamp?: number;
  powerDissipationMilliwatt?: number;
  resistanceOhm?: number;
  tolerancePercent?: number;
  ratedPowerWatt?: number;
  construction?: string;
  mounting?: string;
  contactType?: string;
  terminalGroups?: { id: string; terminalIds: [string, string] }[];
  pressedConnection?: [string, string];
  operatingForceNewton?: number;
  heightMm?: number;
};
type Topology = {
  id: string;
  version: number;
  name: string;
  tiePointCount: number;
  physicalModel: {
    manufacturer: string;
    model: string;
    orderableVariants: string[];
    holePitchMm: number;
    dimensionsMm: { length: number; width: number; height: number };
  };
  coordinateConvention: string;
  sourceIds: string[];
  terminalStripGroups: { id: string; holes: string[] }[];
  railGroups: {
    id: string;
    holes: string[];
    splitCapable: boolean;
    connectivityVariants: { id: string; connectedHoleSets: string[][] }[];
  }[];
  limitations: string[];
};
type Release = {
  schemaVersion: number;
  releaseId: string;
  publishedOn: string;
  status: string;
  sha256: string;
  release: {
    sources: Source[];
    claims: {
      subjectId: string;
      property: string;
      sourceId: string;
      locator: string;
      note: string;
    }[];
    parts: Part[];
    breadboardTopologies: Topology[];
  };
};
type CatalogIndex = { releases: { releaseId: string; publishedOn: string; status: string }[] };
type CatalogSection = 'all' | 'boards' | 'components' | 'breadboards';
type CatalogView = 'curated' | 'board-directory' | 'component-directory';
type BoardDirectoryEntry = {
  id: string;
  manufacturer: string;
  family: string;
  model: string;
  processorFamily: string;
  recordType: 'development-board' | 'system-module' | 'industrial-controller';
  listingStatus: 'listed' | 'end-of-life' | 'legacy';
  productUrl: string;
  documentationUrl: string | null;
  orderableVariants: string[];
  variantCoverage: 'selected-only' | 'not-reviewed';
  supportLevel: 'discovery-only';
};
type BoardDirectory = {
  directoryId: string;
  checkedOn: string;
  coverageNote: string;
  sources: { id: string; manufacturer: string; title: string; url: string; checkedOn: string }[];
  entries: BoardDirectoryEntry[];
};
type ComponentDirectory = {
  directoryId: string;
  checkedOn: string;
  coverageNote: string;
  sources: { id: string; title: string; url: string }[];
  entries: {
    id: string;
    manufacturer: string;
    family: string;
    model: string;
    componentType: 'family' | 'series';
    category: string;
    productUrl: string;
    exactPartNumber: boolean;
    caution: string;
  }[];
};

const partIcon = (category: Part['category']) =>
  category === 'development-board' ? Cpu : category === 'led' ? Zap : Cable;

export function HardwareCatalog() {
  const [releaseId, setReleaseId] = useState('');
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const [section, setSection] = useState<CatalogSection>('all');
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [catalogView, setCatalogView] = useState<CatalogView>('curated');
  const [boardDirectory, setBoardDirectory] = useState<BoardDirectory | null>(null);
  const [boardDirectoryError, setBoardDirectoryError] = useState<unknown>(null);
  const [boardDirectoryRequested, setBoardDirectoryRequested] = useState(false);
  const [componentDirectory, setComponentDirectory] = useState<ComponentDirectory | null>(null);
  const [componentDirectoryError, setComponentDirectoryError] = useState<unknown>(null);
  const [selectedComponentFamilyId, setSelectedComponentFamilyId] = useState('');
  const [boardQuery, setBoardQuery] = useState('');
  const [boardManufacturer, setBoardManufacturer] = useState('all');
  const [selectedBoardId, setSelectedBoardId] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const loadIndex = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api<CatalogIndex>('/catalog', { signal });
      const latest = response.releases?.[0];
      if (!latest) throw new Error('The catalog has no published hardware releases yet.');
      setIndex(response);
      setReleaseId(latest.releaseId);
    } catch (cause) {
      if (!signal?.aborted) setError(cause);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadIndex(controller.signal);
    return () => controller.abort();
  }, [loadIndex]);

  useEffect(() => {
    if (!releaseId) return;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void api<Release>(`/catalog/${encodeURIComponent(releaseId)}`, { signal: controller.signal })
      .then((data) => {
        if (!data.release?.parts || !data.release.sources)
          throw new Error('This catalog release could not be read. Refresh and try again.');
        setRelease(data);
        setSelectedId((current) => current || data.release.parts[0]?.id || '');
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [releaseId]);

  useEffect(() => {
    if (catalogView !== 'board-directory' || boardDirectory || boardDirectoryRequested) return;
    setBoardDirectoryRequested(true);
    setBoardDirectoryError(null);
    void api<BoardDirectory>('/catalog/board-directory')
      .then((data) => {
        setBoardDirectory(data);
        setSelectedBoardId((current) => current || data.entries[0]?.id || '');
      })
      .catch(setBoardDirectoryError);
  }, [catalogView, boardDirectory, boardDirectoryRequested]);

  useEffect(() => {
    if (catalogView !== 'component-directory' || componentDirectory) return;
    void api<ComponentDirectory>('/catalog/component-directory')
      .then((data) => {
        setComponentDirectory(data);
        setSelectedComponentFamilyId((current) => current || data.entries[0]?.id || '');
      })
      .catch(setComponentDirectoryError);
  }, [catalogView, componentDirectory]);

  const filteredParts = useMemo(() => {
    const parts = release?.release.parts ?? [];
    const q = query.trim().toLowerCase();
    return parts.filter((part) => {
      const inSection =
        section === 'all' ||
        (section === 'boards' && part.category === 'development-board') ||
        (section === 'components' && part.category !== 'development-board');
      const matches =
        !q ||
        `${part.manufacturer} ${part.model} ${part.summary} ${part.id}`.toLowerCase().includes(q);
      return inSection && matches;
    });
  }, [release, section, query]);
  const selected = filteredParts.find((part) => part.id === selectedId) ?? filteredParts[0];
  const topology = release?.release.breadboardTopologies[0];
  const filteredBoards = (boardDirectory?.entries ?? []).filter((entry) => {
    const matchesManufacturer =
      boardManufacturer === 'all' || entry.manufacturer === boardManufacturer;
    const matchesQuery =
      !boardQuery.trim() ||
      `${entry.manufacturer} ${entry.family} ${entry.model} ${entry.processorFamily} ${entry.id}`
        .toLowerCase()
        .includes(boardQuery.trim().toLowerCase());
    return matchesManufacturer && matchesQuery;
  });
  const selectedBoard =
    filteredBoards.find((entry) => entry.id === selectedBoardId) ?? filteredBoards[0];
  const boardManufacturers = [
    ...new Set((boardDirectory?.entries ?? []).map((entry) => entry.manufacturer)),
  ];

  return (
    <div className="page catalog-page">
      <div className="catalog-hero">
        <div>
          <span className="eyebrow">PHASE 02 · HARDWARE KNOWLEDGE</span>
          <h1>Know the parts before you connect them.</h1>
          <p className="lead">
            Browse exact, reviewed hardware identities with the manufacturer sources behind each
            fact. A broad name like “ESP32” never chooses a board revision for you.
          </p>
        </div>
        <div className="catalog-release-badge">
          <BookOpen size={18} />
          <span>CURATED RELEASE</span>
          <strong>{releaseId || 'Loading…'}</strong>
          {release && <small>Published {release.publishedOn}</small>}
        </div>
      </div>

      <section className="catalog-scope-note" aria-label="Catalog scope">
        <span className="scope-marker">i</span>
        <p>
          Catalog facts describe the listed manufacturer configuration. They do not confirm what is
          on your workbench, certify a circuit as safe, or fill in missing electrical limits.
        </p>
      </section>

      <div className="catalog-view-tabs" role="group" aria-label="Catalog view">
        <button
          type="button"
          aria-pressed={catalogView === 'curated'}
          onClick={() => setCatalogView('curated')}
        >
          Circuit-ready catalog
        </button>
        <button
          type="button"
          aria-pressed={catalogView === 'board-directory'}
          onClick={() => setCatalogView('board-directory')}
        >
          Official board index
        </button>
        <button
          type="button"
          aria-pressed={catalogView === 'component-directory'}
          onClick={() => setCatalogView('component-directory')}
        >
          Component discovery
        </button>
      </div>

      {catalogView === 'curated' ? (
        <>
          <section className="catalog-browser" aria-label="Hardware parts">
            <aside className="catalog-list-panel">
              <div className="catalog-list-heading">
                <span className="eyebrow">RELEASE CONTENTS</span>
                <strong>{release?.release.parts.length ?? '—'} exact parts</strong>
              </div>
              <div className="catalog-search">
                <Search size={16} />
                <label className="sr-only" htmlFor="catalog-search">
                  Search hardware catalog
                </label>
                <input
                  id="catalog-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search parts…"
                />
              </div>
              <div className="catalog-filters" role="group" aria-label="Filter catalog">
                {(
                  [
                    ['all', 'All'],
                    ['boards', 'Boards'],
                    ['components', 'Components'],
                  ] as [CatalogSection, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={section === value ? 'selected' : ''}
                    onClick={() => setSection(value)}
                    aria-pressed={section === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {busy ? (
                <Loading />
              ) : (
                <div className="catalog-part-list" role="listbox" aria-label="Select a part">
                  {filteredParts.map((part) => {
                    const Icon = partIcon(part.category);
                    return (
                      <button
                        key={part.id}
                        className={`catalog-part-option ${selected?.id === part.id ? 'selected' : ''}`}
                        role="option"
                        aria-selected={selected?.id === part.id}
                        onClick={() => setSelectedId(part.id)}
                      >
                        <span className="catalog-part-icon">
                          <Icon size={17} />
                        </span>
                        <span>
                          <small>{part.manufacturer}</small>
                          <strong>{part.model}</strong>
                          <em>{categoryName(part.category)}</em>
                        </span>
                      </button>
                    );
                  })}
                  {!filteredParts.length && !error && (
                    <p className="catalog-empty">No catalog entries match this search.</p>
                  )}
                </div>
              )}
            </aside>

            <div className="catalog-detail-panel">
              <ErrorNotice error={error} onRetry={() => void loadIndex()} />
              {busy && !release ? (
                <Loading />
              ) : selected ? (
                <PartDetail
                  part={selected}
                  sources={release?.release.sources ?? []}
                  claims={release?.release.claims ?? []}
                />
              ) : !error ? (
                <div className="catalog-empty-detail">
                  Choose a catalog entry to inspect its reviewed details.
                </div>
              ) : null}
            </div>
          </section>

          {topology && (
            <BreadboardDetail
              topology={topology}
              sources={release?.release.sources ?? []}
              claims={release?.release.claims ?? []}
            />
          )}
        </>
      ) : catalogView === 'board-directory' ? (
        <section
          className="catalog-browser board-directory-browser"
          aria-label="Official board index"
        >
          <aside className="catalog-list-panel">
            <div className="catalog-list-heading">
              <span className="eyebrow">MANUFACTURER LISTINGS</span>
              <strong>
                {boardDirectory ? `${boardDirectory.entries.length} models` : 'Loading…'}
              </strong>
            </div>
            <div className="catalog-search">
              <Search size={16} />
              <label className="sr-only" htmlFor="board-directory-search">
                Search official board index
              </label>
              <input
                id="board-directory-search"
                value={boardQuery}
                onChange={(event) => setBoardQuery(event.target.value)}
                placeholder="Search board, family, processor…"
              />
            </div>
            <div className="catalog-filters" role="group" aria-label="Filter board manufacturer">
              {['all', ...boardManufacturers].map((manufacturer) => (
                <button
                  key={manufacturer}
                  type="button"
                  className={boardManufacturer === manufacturer ? 'selected' : ''}
                  aria-pressed={boardManufacturer === manufacturer}
                  onClick={() => setBoardManufacturer(manufacturer)}
                >
                  {manufacturer === 'all' ? 'All' : manufacturer}
                </button>
              ))}
            </div>
            {boardDirectoryError ? (
              <ErrorNotice
                error={boardDirectoryError}
                onRetry={() => {
                  setBoardDirectoryRequested(false);
                  setBoardDirectoryError(null);
                }}
              />
            ) : !boardDirectory ? (
              <Loading />
            ) : (
              <div className="catalog-part-list" role="listbox" aria-label="Select a board model">
                {filteredBoards.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`catalog-part-option ${selectedBoard?.id === entry.id ? 'selected' : ''}`}
                    role="option"
                    aria-selected={selectedBoard?.id === entry.id}
                    onClick={() => setSelectedBoardId(entry.id)}
                  >
                    <span className="catalog-part-icon">
                      <Cpu size={17} />
                    </span>
                    <span>
                      <small>
                        {entry.manufacturer} · {entry.family}
                      </small>
                      <strong>{entry.model}</strong>
                      <em>
                        {entry.listingStatus === 'end-of-life'
                          ? 'End of life'
                          : entry.listingStatus === 'legacy'
                            ? 'Legacy listing'
                            : entry.recordType.replaceAll('-', ' ')}
                      </em>
                    </span>
                  </button>
                ))}
                {filteredBoards.length === 0 && (
                  <p className="catalog-empty">No board models match this search.</p>
                )}
              </div>
            )}
          </aside>
          <div className="catalog-detail-panel">
            {selectedBoard ? (
              <BoardDirectoryDetail entry={selectedBoard} />
            ) : boardDirectoryError ? null : (
              <div className="catalog-empty-detail">
                Choose a board model to inspect its official sources.
              </div>
            )}
          </div>
          {boardDirectory && (
            <div className="board-directory-notice">
              <strong>Discovery index · checked {boardDirectory.checkedOn}</strong>
              <p>{boardDirectory.coverageNote}</p>
              <div>
                {boardDirectory.sources.map((source) => (
                  <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                    {source.title} <ArrowUpRight size={14} />
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : (
        <section
          className="catalog-browser board-directory-browser"
          aria-label="Component discovery index"
        >
          <aside className="catalog-list-panel">
            <div className="catalog-list-heading">
              <span className="eyebrow">COMMON COMPONENT FAMILIES</span>
              <strong>
                {componentDirectory ? `${componentDirectory.entries.length} families` : 'Loading…'}
              </strong>
            </div>
            {componentDirectoryError ? (
              <ErrorNotice
                error={componentDirectoryError}
                onRetry={() => {
                  setComponentDirectoryError(null);
                  setComponentDirectory(null);
                }}
              />
            ) : !componentDirectory ? (
              <Loading />
            ) : (
              <div
                className="catalog-part-list"
                role="listbox"
                aria-label="Select a component family"
              >
                {componentDirectory.entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`catalog-part-option ${selectedComponentFamilyId === entry.id ? 'selected' : ''}`}
                    role="option"
                    aria-selected={selectedComponentFamilyId === entry.id}
                    onClick={() => setSelectedComponentFamilyId(entry.id)}
                  >
                    <span className="catalog-part-icon">
                      <Layers3 size={17} />
                    </span>
                    <span>
                      <small>
                        {entry.manufacturer} · {formatWords(entry.category)}
                      </small>
                      <strong>{entry.model}</strong>
                      <em>{entry.componentType} · discovery only</em>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>
          <div className="catalog-detail-panel">
            {componentDirectory &&
              (() => {
                const entry = componentDirectory.entries.find(
                  (item) => item.id === selectedComponentFamilyId,
                );
                return entry ? (
                  <>
                    <div className="detail-kicker">
                      <span className="eyebrow">
                        {entry.manufacturer.toUpperCase()} · COMPONENT DISCOVERY
                      </span>
                      <span className="identity-chip">Discovery only</span>
                    </div>
                    <h2>{entry.model}</h2>
                    <div className="catalog-fact-grid">
                      <Fact label="Category" value={formatWords(entry.category)} />
                      <Fact label="Record type" value={entry.componentType} />
                      <Fact
                        label="Exact part number"
                        value={entry.exactPartNumber ? 'Yes' : 'No; family-level record'}
                      />
                      <Fact label="Circuit-ready support" value="Not included" />
                    </div>
                    <p className="catalog-part-summary">{entry.caution}</p>
                    <p>{componentDirectory.coverageNote}</p>
                    <h3>Manufacturer references</h3>
                    <div className="board-source-links">
                      <a href={entry.productUrl} target="_blank" rel="noreferrer">
                        Manufacturer product page <ArrowUpRight size={14} />
                      </a>
                      {componentDirectory.sources
                        .filter((source) => source.id === entry.id.split('.')[0])
                        .map((source) => (
                          <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                            {source.title} <ArrowUpRight size={14} />
                          </a>
                        ))}
                    </div>
                  </>
                ) : (
                  <Loading />
                );
              })()}
          </div>
        </section>
      )}

      {catalogView === 'curated' && release && (
        <footer className="catalog-provenance">
          <span>Release digest · SHA-256</span>
          <code>{release.sha256}</code>
          <span>Catalog schema v{release.schemaVersion}</span>
        </footer>
      )}
    </div>
  );
}

function BoardDirectoryDetail({ entry }: { entry: BoardDirectoryEntry }) {
  return (
    <article className="catalog-part-detail board-directory-detail">
      <div className="detail-kicker">
        <span className="eyebrow">{entry.manufacturer} · BOARD DISCOVERY</span>
        <span className="identity-chip">Discovery only</span>
      </div>
      <h2>{entry.model}</h2>
      <p className="catalog-part-summary">
        This is a manufacturer-indexed board identity. Schemora has not verified its pin map,
        physical revision, or electrical compatibility for circuit editing.
      </p>
      <div className="catalog-fact-grid">
        <Fact label="Board family" value={entry.family} />
        <Fact label="Processor family" value={entry.processorFamily} />
        <Fact label="Product type" value={formatWords(entry.recordType)} />
        <Fact
          label="Manufacturer listing status"
          value={
            entry.listingStatus === 'end-of-life'
              ? 'End of life'
              : entry.listingStatus === 'legacy'
                ? 'Legacy listing; current availability unverified'
                : 'Listed on current manufacturer index'
          }
        />
        <Fact
          label="Orderable variant coverage"
          value={
            entry.variantCoverage === 'selected-only'
              ? 'Selected variants only; not exhaustive'
              : 'Not reviewed in this index'
          }
        />
      </div>
      {entry.orderableVariants.length > 0 && (
        <section className="catalog-subsection">
          <h3>Selected manufacturer order codes</h3>
          <ul className="board-variants">
            {entry.orderableVariants.map((variant) => (
              <li key={variant}>{variant}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="catalog-subsection">
        <h3>Official references</h3>
        <div className="board-source-links">
          <a href={entry.productUrl} target="_blank" rel="noreferrer">
            Manufacturer product directory <ArrowUpRight size={15} />
          </a>
          {entry.documentationUrl && (
            <a href={entry.documentationUrl} target="_blank" rel="noreferrer">
              Board documentation <ArrowUpRight size={15} />
            </a>
          )}
        </div>
      </section>
      <p className="board-support-boundary">
        Check the exact order code, module, antenna, memory, headers, and PCB revision in the source
        documents. Do not use this discovery entry to wire a circuit or choose a firmware target.
      </p>
    </article>
  );
}

function categoryName(category: Part['category']) {
  return category === 'development-board'
    ? 'Development board'
    : category === 'led'
      ? 'LED'
      : category === 'resistor'
        ? 'Resistor'
        : 'Pushbutton';
}

function PartDetail({
  part,
  sources,
  claims,
}: {
  part: Part;
  sources: Source[];
  claims: Release['release']['claims'];
}) {
  const partClaims = claims.filter((claim) => claim.subjectId === part.id);
  const partSources = sources.filter((source) => part.sourceIds.includes(source.id));
  return (
    <article className="catalog-part-detail">
      <div className="detail-kicker">
        <span className="eyebrow">{categoryName(part.category)} · EXACT IDENTITY</span>
        <span className="identity-chip">{part.identityScope}</span>
      </div>
      <h2>{part.model}</h2>
      <p className="catalog-part-summary">{part.summary}</p>
      <div className="catalog-fact-grid">
        {part.category === 'development-board' && (
          <>
            <Fact label="Module" value={part.configuration?.module ?? 'Not recorded'} />
            <Fact
              label="Headers"
              value={`${part.configuration?.header ?? 'Unknown'} pin headers`}
            />
            <Fact
              label="Module operating supply"
              value={
                part.moduleOperatingSupplyVolt
                  ? `${part.moduleOperatingSupplyVolt.minimum}–${part.moduleOperatingSupplyVolt.maximum} V`
                  : 'Not recorded'
              }
            />
            <Fact
              label="Board supply options"
              value={(part.supplyOptions ?? []).map(formatWords).join(' · ') || 'Not recorded'}
            />
          </>
        )}
        {part.category === 'led' && (
          <>
            <Fact
              label="Package / color"
              value={`${part.package ?? 'Unknown'} · ${part.color ?? 'Unknown'}`}
            />
            <Fact
              label="Forward voltage at 10 mA"
              value={
                part.forwardVoltage
                  ? `${part.forwardVoltage.typicalVolt} V typical · ${part.forwardVoltage.maximumVolt} V maximum`
                  : 'Not recorded'
              }
            />
            <Fact
              label="Maximum DC forward current"
              value={
                part.maximumDcForwardCurrentMilliamp
                  ? `${part.maximumDcForwardCurrentMilliamp} mA`
                  : 'Not recorded'
              }
            />
            <Fact
              label="Power dissipation"
              value={
                part.powerDissipationMilliwatt
                  ? `${part.powerDissipationMilliwatt} mW`
                  : 'Not recorded'
              }
            />
          </>
        )}
        {part.category === 'resistor' && (
          <>
            <Fact
              label="Resistance"
              value={part.resistanceOhm ? `${part.resistanceOhm} Ω` : 'Not recorded'}
            />
            <Fact
              label="Tolerance"
              value={part.tolerancePercent ? `±${part.tolerancePercent}%` : 'Not recorded'}
            />
            <Fact
              label="Rated power"
              value={part.ratedPowerWatt ? `${part.ratedPowerWatt} W` : 'Not recorded'}
            />
            <Fact
              label="Construction"
              value={`${part.construction ?? 'Unknown'} · ${part.mounting ?? 'Unknown'}`}
            />
          </>
        )}
        {part.category === 'pushbutton' && (
          <>
            <Fact label="Package" value={part.package ?? 'Not recorded'} />
            <Fact label="Contact type" value={part.contactType ?? 'Not recorded'} />
            <Fact
              label="Operating force / height"
              value={
                part.operatingForceNewton && part.heightMm
                  ? `${part.operatingForceNewton} N · ${part.heightMm} mm`
                  : 'Not recorded'
              }
            />
            <Fact
              label="Internal contact groups"
              value={
                part.terminalGroups
                  ?.map((group) => `${group.id}: ${group.terminalIds.join(' / ')}`)
                  .join(' · ') ?? 'Not recorded'
              }
            />
            <Fact
              label="Press connection"
              value={part.pressedConnection?.join(' ↔ ') ?? 'Not recorded'}
            />
          </>
        )}
      </div>

      {part.pins && (
        <section className="catalog-subsection" aria-labelledby="catalog-pins-title">
          <div className="catalog-subheading">
            <div>
              <span className="eyebrow">DOCUMENTED HEADER ALIASES</span>
              <h3 id="catalog-pins-title">Pin references</h3>
            </div>
            <span className="fine-text">Position is on the board header</span>
          </div>
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th scope="col">Header</th>
                  <th scope="col">Position</th>
                  <th scope="col">Printed label</th>
                  <th scope="col">Function</th>
                  <th scope="col">Scenario use</th>
                </tr>
              </thead>
              <tbody>
                {part.pins.map((pin) => (
                  <tr key={pin.terminalId}>
                    <td>{pin.header}</td>
                    <td>{pin.position}</td>
                    <td>
                      <strong>{pin.printedLabel}</strong>
                    </td>
                    <td>{pin.functions.join(', ')}</td>
                    <td>{pin.availableForScenario ? 'Available' : 'Not enabled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="catalog-subsection" aria-labelledby="catalog-terminals-title">
        <div className="catalog-subheading">
          <div>
            <span className="eyebrow">MACHINE-READABLE CONNECTION POINTS</span>
            <h3 id="catalog-terminals-title">Modeled terminals</h3>
          </div>
        </div>
        <div className="terminal-list">
          {part.terminals.map((terminal) => (
            <div key={terminal.id}>
              <span className="terminal-role">{terminal.electricalRole}</span>
              <strong>{terminal.label}</strong>
              <code>{terminal.id}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="catalog-subsection" aria-labelledby="catalog-sources-title">
        <div className="catalog-subheading">
          <div>
            <span className="eyebrow">TRACEABLE FACTS</span>
            <h3 id="catalog-sources-title">Manufacturer sources</h3>
          </div>
        </div>
        <div className="catalog-source-list">
          {partSources.map((source) => (
            <div key={source.id} className="catalog-source-card">
              <div>
                <strong>{source.title}</strong>
                <small>
                  {source.publisher}
                  {source.documentRevision ? ` · ${source.documentRevision}` : ''} · accessed{' '}
                  {source.accessedOn}
                </small>
              </div>
              <a href={source.url} target="_blank" rel="noreferrer">
                Open source <ArrowUpRight size={14} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              {partClaims
                .filter((claim) => claim.sourceId === source.id)
                .map((claim) => (
                  <p key={claim.property}>
                    <b>{claim.property}</b> · {claim.locator}
                    <br />
                    {claim.note}
                  </p>
                ))}
            </div>
          ))}
        </div>
      </section>

      <section className="catalog-limits" aria-labelledby="catalog-limits-title">
        <h3 id="catalog-limits-title">What this record does not establish</h3>
        <ul>
          {part.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="catalog-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BreadboardDetail({
  topology,
  sources,
  claims,
}: {
  topology: Topology;
  sources: Source[];
  claims: Release['release']['claims'];
}) {
  const topologySources = sources.filter((source) => topology.sourceIds.includes(source.id));
  const topologyClaims = claims.filter((claim) => claim.subjectId === topology.id);
  return (
    <section className="breadboard-panel" aria-labelledby="breadboard-title">
      <div className="breadboard-heading">
        <div>
          <span className="eyebrow">SUPPORTED BREADBOARD TOPOLOGY · V{topology.version}</span>
          <h2 id="breadboard-title">
            {topology.physicalModel.manufacturer} {topology.physicalModel.model}
          </h2>
          <p>{topology.name}</p>
        </div>
        <div className="breadboard-stats">
          <strong>
            {topology.tiePointCount}
            <small> tie points</small>
          </strong>
          <strong>
            {topology.physicalModel.holePitchMm} mm<small> hole pitch</small>
          </strong>
          <strong>
            {topology.physicalModel.dimensionsMm.length} ×{' '}
            {topology.physicalModel.dimensionsMm.width} ×{' '}
            {topology.physicalModel.dimensionsMm.height} mm<small> body dimensions</small>
          </strong>
        </div>
      </div>
      <div className="breadboard-layout">
        <div
          className="breadboard-visual"
          role="img"
          aria-label="Topology diagram: five-hole vertical terminal groups on both sides of the center gap and four continuous horizontal rails"
        >
          <div className="breadboard-edge">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index}>
                <span>RAIL {index + 1}</span>
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
            ))}
          </div>
          <div className="breadboard-terminal-bank">
            <div className="hole-rows">
              {['A', 'B', 'C', 'D', 'E'].map((row) => (
                <div key={row}>
                  <b>{row}</b>
                  {Array.from({ length: 12 }, (_, n) => (
                    <i key={n} />
                  ))}
                </div>
              ))}
            </div>
            <small>30 groups · 5 connected holes each</small>
          </div>
          <span className="breadboard-gap">CENTER GAP</span>
          <div className="breadboard-terminal-bank">
            <div className="hole-rows">
              {['F', 'G', 'H', 'I', 'J'].map((row) => (
                <div key={row}>
                  <b>{row}</b>
                  {Array.from({ length: 12 }, (_, n) => (
                    <i key={n} />
                  ))}
                </div>
              ))}
            </div>
            <small>30 groups · 5 connected holes each</small>
          </div>
          <div className="breadboard-edge">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index}>
                <span>RAIL {index + 1}</span>
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
            ))}
          </div>
        </div>
        <div className="breadboard-facts">
          <h3>Connectivity model</h3>
          <p>
            Each A–E and F–J column forms its own five-hole group. The center gap separates the two
            terminal areas. The release models four independent, continuous 25-hole rails.
          </p>
          <ul>
            <li>Terminal strip groups: {topology.terminalStripGroups.length}</li>
            <li>
              Rails: {topology.railGroups.length}, each with{' '}
              {topology.railGroups[0]?.holes.length ?? 0} holes
            </li>
            <li>
              Rails split in this model:{' '}
              {topology.railGroups.some((rail) => rail.splitCapable) ? 'Yes' : 'No'}
            </li>
            <li>Listed versions: {topology.physicalModel.orderableVariants.join(', ')}</li>
          </ul>
          <p className="fine-text">{topology.coordinateConvention}</p>
        </div>
      </div>
      <div className="catalog-subsection">
        <div className="catalog-subheading">
          <div>
            <span className="eyebrow">TOPOLOGY PROVENANCE</span>
            <h3>Sources and modeled claims</h3>
          </div>
        </div>
        <div className="catalog-source-list">
          {topologySources.map((source) => (
            <div key={source.id} className="catalog-source-card">
              <div>
                <strong>{source.title}</strong>
                <small>
                  {source.publisher}
                  {source.documentRevision ? ` · ${source.documentRevision}` : ''}
                </small>
              </div>
              <a href={source.url} target="_blank" rel="noreferrer">
                Open source <ArrowUpRight size={14} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              {topologyClaims
                .filter((claim) => claim.sourceId === source.id)
                .map((claim) => (
                  <p key={claim.property}>
                    <b>{claim.property}</b> · {claim.locator}
                    <br />
                    {claim.note}
                  </p>
                ))}
            </div>
          ))}
        </div>
      </div>
      <div className="catalog-limits">
        <h3>Physical verification still matters</h3>
        <ul>
          {topology.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function formatWords(value: string) {
  return value.replaceAll('-', ' ');
}
