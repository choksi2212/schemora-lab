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

const partIcon = (category: Part['category']) =>
  category === 'development-board' ? Cpu : category === 'led' ? Zap : Cable;

export function HardwareCatalog() {
  const [releaseId, setReleaseId] = useState('');
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const [section, setSection] = useState<CatalogSection>('all');
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
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

      {release && (
        <footer className="catalog-provenance">
          <span>Release digest · SHA-256</span>
          <code>{release.sha256}</code>
          <span>Catalog schema v{release.schemaVersion}</span>
        </footer>
      )}
    </div>
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
