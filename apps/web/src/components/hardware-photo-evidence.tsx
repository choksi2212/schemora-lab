'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  Camera,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Upload,
  ScanSearch,
  CheckCircle2,
} from 'lucide-react';
import { api, friendlyError, type ProjectDetail } from '@/lib/api';

const PHOTO_LIMIT_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CONSENT_VERSION = 'photo-evidence-v1' as const;
const RECOGNITION_CONSENT_VERSION = 'photo-recognition-remote-v1' as const;
const RECOGNITION_PURPOSE = 'identify-visible-hardware-candidates' as const;

type ShotRole = 'board-top' | 'board-back' | 'pin-labels' | 'module-top' | 'markings' | 'other';
type HardwarePhoto = {
  id: string;
  shotRole: ShotRole;
  createdAt: string;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  status: 'manual_review';
};
type PhotoList = { items: HardwarePhoto[] };
type PhotoCreate = { photo: HardwarePhoto };
type PhotoCreateBody = {
  expectedRevision: number;
  shotRole: ShotRole;
  consentVersion: typeof CONSENT_VERSION;
  contentBase64: string;
};
type RecognitionProposal = {
  outcome: 'exact-candidate' | 'ambiguous' | 'unknown' | 'unsupported' | 'unclear';
  candidates: {
    catalogPartId: string;
    rank: number;
    basis: string;
    visibleMarkings: {
      text: string;
      region: { x: number; y: number; width: number; height: number } | null;
    }[];
  }[];
  observations: {
    text: string;
    region: { x: number; y: number; width: number; height: number } | null;
  }[];
  limitations: string[];
};
type HardwareRecognition = {
  id: string;
  photoId: string;
  catalogReleaseId: string;
  providerId: string;
  modelId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  outcome: RecognitionProposal['outcome'] | null;
  proposal: RecognitionProposal | null;
  errorCode: string | null;
  createdAt: string;
};
type RecognitionCapability = {
  enabled: boolean;
  providerId: string;
  providerName: string;
  modelId: string;
  noticeRevision: string;
};
type CatalogPart = { id: string; manufacturer: string; model: string; category: string };
type HardwareInventoryItem = {
  id: string;
  catalogReleaseId: string;
  catalogPartId: string;
  label: string;
  sourceRecognitionId: string | null;
  linkedComponentId: string | null;
  linkedGraphSnapshotId: string | null;
  confirmedAt: string;
};
type CircuitOverview = {
  snapshotId: string;
  catalogReleaseId: string;
  components: { id: string; catalogPartId: string }[];
};

const shotRoleLabels: Record<ShotRole, string> = {
  'board-top': 'Board top',
  'board-back': 'Board back',
  'pin-labels': 'Pin labels',
  'module-top': 'Module top',
  markings: 'Model or markings',
  other: 'Other hardware view',
};

function photoError(file: File): string | null {
  if (!ACCEPTED_TYPES.has(file.type)) return 'Choose a JPEG, PNG, or WebP image.';
  if (file.size === 0) return 'This image is empty. Choose another photo.';
  if (file.size > PHOTO_LIMIT_BYTES) return 'Each photo must be 5 MiB or smaller.';
  return null;
}

function encodeBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The selected photo could not be read.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The selected photo could not be read.'));
        return;
      }
      const encoded = reader.result.split(',', 2)[1];
      if (!encoded) reject(new Error('The selected photo could not be encoded.'));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

function postPhoto(
  projectId: string,
  body: PhotoCreateBody,
  idempotencyKey: string,
  onProgress: (percent: number) => void,
): Promise<PhotoCreate> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      'POST',
      `/api/backend/v1/projects/${encodeURIComponent(projectId)}/hardware-photos`,
    );
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/json');
    request.setRequestHeader('Idempotency-Key', idempotencyKey);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    request.onerror = () =>
      reject(new Error('Could not reach your workspace. Check your connection and retry.'));
    request.onload = () => {
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        reject(new Error('We received an unexpected response. Refresh and try again.'));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        const error =
          payload && typeof payload === 'object' && 'error' in payload
            ? (payload as { error?: { message?: string } }).error
            : undefined;
        reject(new Error(error?.message ?? 'The photo could not be saved. Please try again.'));
        return;
      }
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('data' in payload) ||
        !(payload as { data?: { photo?: unknown } }).data?.photo
      ) {
        reject(new Error('We received an unexpected response. Refresh and try again.'));
        return;
      }
      resolve((payload as { data: PhotoCreate }).data);
    };
    request.send(JSON.stringify(body));
  });
}

export function HardwarePhotoEvidence({
  projectId,
  revision,
  editable,
  onRevision,
}: {
  projectId: string;
  revision: number;
  editable: boolean;
  onRevision: (revision: number) => void;
}) {
  const [photos, setPhotos] = useState<HardwarePhoto[]>([]);
  const [recognitions, setRecognitions] = useState<HardwareRecognition[]>([]);
  const [recognitionCapability, setRecognitionCapability] = useState<RecognitionCapability | null>(
    null,
  );
  const [catalogParts, setCatalogParts] = useState<Record<string, CatalogPart>>({});
  const [inventory, setInventory] = useState<HardwareInventoryItem[]>([]);
  const [circuit, setCircuit] = useState<CircuitOverview | null>(null);
  const [componentSelections, setComponentSelections] = useState<Record<string, string>>({});
  const [recognitionConsent, setRecognitionConsent] = useState<Record<string, boolean>>({});
  const [activeRecognitionPhotoId, setActiveRecognitionPhotoId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [shotRole, setShotRole] = useState<ShotRole>('board-top');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState('');
  const [activeFile, setActiveFile] = useState('');
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const idempotencyKeys = useRef(new WeakMap<File, string>());
  const deleteIdempotencyKeys = useRef(new Map<string, string>());

  const loadRecognitions = useCallback(
    async (signal?: AbortSignal) => {
      const response = await api<{ items: HardwareRecognition[] }>(
        `/projects/${projectId}/hardware-recognitions`,
        { signal },
      );
      if (!signal?.aborted) setRecognitions(response.items);
    },
    [projectId],
  );

  const loadPhotos = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const response = await api<PhotoList>(`/projects/${projectId}/hardware-photos`, { signal });
        if (!signal?.aborted) setPhotos(response.items);
        await loadRecognitions(signal);
      } catch (cause) {
        if (!signal?.aborted) setError(friendlyError(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [loadRecognitions, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadPhotos(controller.signal);
    return () => controller.abort();
  }, [loadPhotos]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<RecognitionCapability>('/hardware-recognition-capability', { signal: controller.signal }),
      api<{
        releases: { releaseId: string; parts: CatalogPart[] }[];
      }>('/catalog', { signal: controller.signal }),
      api<{ items: HardwareInventoryItem[] }>(`/projects/${projectId}/hardware-inventory`, {
        signal: controller.signal,
      }),
      api<{
        graphSnapshot: null | {
          id: string;
          graph: { catalogReleaseId: string; components: { id: string; catalogPartId: string }[] };
        };
      }>(`/projects/${projectId}/circuit`, { signal: controller.signal }),
    ])
      .then(([capability, catalog, savedInventory, savedCircuit]) => {
        if (controller.signal.aborted) return;
        setRecognitionCapability(capability);
        const current = catalog.releases[0];
        setCatalogParts(Object.fromEntries((current?.parts ?? []).map((part) => [part.id, part])));
        setInventory(savedInventory.items);
        setComponentSelections(
          Object.fromEntries(
            savedInventory.items
              .filter((item) => item.linkedComponentId)
              .map((item) => [item.id, item.linkedComponentId!]),
          ),
        );
        setCircuit(
          savedCircuit.graphSnapshot
            ? {
                snapshotId: savedCircuit.graphSnapshot.id,
                catalogReleaseId: savedCircuit.graphSnapshot.graph.catalogReleaseId,
                components: savedCircuit.graphSnapshot.graph.components,
              }
            : null,
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(friendlyError(cause));
      });
    return () => controller.abort();
  }, [projectId, revision]);

  useEffect(() => {
    if (!recognitions.some((item) => item.status === 'queued' || item.status === 'running')) return;
    const timer = window.setInterval(() => void loadRecognitions(), 2500);
    return () => window.clearInterval(timer);
  }, [loadRecognitions, recognitions]);

  function selectFiles(selection: FileList | null) {
    if (!selection) return;
    const next = Array.from(selection);
    const invalid = next.map(photoError).find(Boolean);
    setError(invalid ?? '');
    setStatus('');
    setFiles(invalid ? [] : next);
  }

  async function uploadFiles(event: React.FormEvent) {
    event.preventDefault();
    if (!editable || uploading || !files.length || !consent) return;
    setUploading(true);
    setError('');
    setStatus('');
    let uploaded = 0;
    let expectedRevision = revision;
    try {
      for (const [index, file] of files.entries()) {
        setActiveFile(`Preparing photo ${index + 1} of ${files.length}: ${file.name}`);
        const contentBase64 = await encodeBase64(file);
        setActiveFile(`Uploading photo ${index + 1} of ${files.length}: ${file.name}`);
        setUploadPercent(0);
        let idempotencyKey = idempotencyKeys.current.get(file);
        if (!idempotencyKey) {
          idempotencyKey = crypto.randomUUID();
          idempotencyKeys.current.set(file, idempotencyKey);
        }
        const result = await postPhoto(
          projectId,
          {
            expectedRevision,
            shotRole,
            consentVersion: CONSENT_VERSION,
            contentBase64,
          },
          idempotencyKey,
          setUploadPercent,
        );
        setPhotos((previous) => [
          result.photo,
          ...previous.filter((photo) => photo.id !== result.photo.id),
        ]);
        idempotencyKeys.current.delete(file);
        setFiles((previous) => previous.filter((pending) => pending !== file));
        uploaded += 1;

        // The photo endpoint returns the photo record only. Refresh the project revision before
        // posting another file so each sequential write uses the current revision precondition.
        const latest = await api<ProjectDetail>(`/projects/${projectId}`);
        expectedRevision = latest.project.revision;
        onRevision(latest.project.revision);
      }
      setFiles([]);
      setConsent(false);
      setStatus(`${uploaded} photo${uploaded === 1 ? '' : 's'} saved for manual review.`);
      await loadPhotos();
    } catch (cause) {
      const message = friendlyError(cause);
      if (uploaded) {
        setStatus(
          `${uploaded} photo${uploaded === 1 ? '' : 's'} saved. The remaining selected photos are still available to retry.`,
        );
        try {
          const latest = await api<ProjectDetail>(`/projects/${projectId}`);
          onRevision(latest.project.revision);
        } catch {
          // Keep the saved evidence visible even if the revision refresh is temporarily unavailable.
        }
      }
      await loadPhotos();
      setError(message);
    } finally {
      setActiveFile('');
      setUploadPercent(null);
      setUploading(false);
    }
  }

  async function deletePhoto(photo: HardwarePhoto) {
    if (!editable || uploading || deletingPhotoId) return;
    setDeletingPhotoId(photo.id);
    setError('');
    setStatus('');
    let idempotencyKey = deleteIdempotencyKeys.current.get(photo.id);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      deleteIdempotencyKeys.current.set(photo.id, idempotencyKey);
    }
    try {
      const result = await api<{ project: { revision: number }; deletedPhotoId: string }>(
        `/projects/${projectId}/hardware-photos/${encodeURIComponent(photo.id)}`,
        {
          method: 'DELETE',
          body: { expectedRevision: revision },
          idempotencyKey,
        },
      );
      deleteIdempotencyKeys.current.delete(photo.id);
      setPhotos((previous) => previous.filter((item) => item.id !== result.deletedPhotoId));
      onRevision(Math.max(revision, result.project.revision));
      try {
        const latest = await api<ProjectDetail>(`/projects/${projectId}`);
        onRevision(latest.project.revision);
      } catch {
        // Keep the monotonic revision from the delete response if refresh is unavailable.
      }
      setStatus('Photo removed. Private image deletion is queued.');
    } catch (cause) {
      const message = friendlyError(cause);
      try {
        const latest = await api<ProjectDetail>(`/projects/${projectId}`);
        onRevision(latest.project.revision);
      } catch {
        // Preserve the retry key if the deletion result is ambiguous.
      }
      await loadPhotos();
      setError(message);
    } finally {
      setDeletingPhotoId('');
    }
  }

  async function requestRecognition(photo: HardwarePhoto) {
    if (!editable || activeRecognitionPhotoId || !recognitionCapability?.enabled) return;
    if (!recognitionConsent[photo.id]) {
      setError('Review and accept the remote recognition notice for this photo first.');
      return;
    }
    setActiveRecognitionPhotoId(photo.id);
    setError('');
    setStatus('');
    try {
      const result = await api<{ project: { revision: number }; recognition: HardwareRecognition }>(
        `/projects/${projectId}/hardware-photos/${encodeURIComponent(photo.id)}/recognitions`,
        {
          method: 'POST',
          body: {
            expectedRevision: revision,
            consent: {
              version: RECOGNITION_CONSENT_VERSION,
              providerId: recognitionCapability.providerId,
              modelId: recognitionCapability.modelId,
              purpose: RECOGNITION_PURPOSE,
              noticeRevision: recognitionCapability.noticeRevision,
            },
          },
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setRecognitions((previous) => [
        result.recognition,
        ...previous.filter((item) => item.id !== result.recognition.id),
      ]);
      setRecognitionConsent((previous) => ({ ...previous, [photo.id]: false }));
      onRevision(result.project.revision);
      setStatus(
        'Photo submitted for a remote visual suggestion. Review the result before confirming any hardware.',
      );
    } catch (cause) {
      setError(friendlyError(cause));
      try {
        const latest = await api<ProjectDetail>(`/projects/${projectId}`);
        onRevision(latest.project.revision);
      } catch {
        // Keep the latest known revision; the request can be retried after refresh.
      }
    } finally {
      setActiveRecognitionPhotoId('');
    }
  }

  async function confirmCandidate(recognition: HardwareRecognition, partId: string) {
    if (
      !editable ||
      !recognition.proposal ||
      !recognition.proposal.candidates.some((item) => item.catalogPartId === partId)
    )
      return;
    const part = catalogParts[partId];
    if (!part) {
      setError('This catalog item is no longer available. Refresh the project before confirming.');
      return;
    }
    setActiveRecognitionPhotoId(recognition.photoId);
    setError('');
    setStatus('');
    try {
      const result = await api<{
        project: { revision: number };
        item: {
          id: string;
          catalogReleaseId: string;
          catalogPartId: string;
          label: string;
          sourceRecognitionId: string | null;
          linkedComponentId: string | null;
          linkedGraphSnapshotId: string | null;
          confirmedAt: string;
        };
      }>(
        `/projects/${projectId}/hardware-recognitions/${encodeURIComponent(recognition.id)}/confirm`,
        {
          method: 'POST',
          body: {
            expectedRevision: revision,
            catalogReleaseId: recognition.catalogReleaseId,
            catalogPartId: partId,
          },
        },
      );
      setInventory((previous) => [
        result.item,
        ...previous.filter((item) => item.id !== result.item.id),
      ]);
      onRevision(result.project.revision);
      setStatus(`Confirmed ${part.manufacturer} ${part.model} in project hardware inventory.`);
    } catch (cause) {
      setError(friendlyError(cause));
      try {
        const latest = await api<ProjectDetail>(`/projects/${projectId}`);
        onRevision(latest.project.revision);
      } catch {
        // Keep the latest known revision until the next refresh.
      }
    } finally {
      setActiveRecognitionPhotoId('');
    }
  }

  async function removeInventoryItem(itemId: string) {
    if (!editable || Boolean(activeRecognitionPhotoId)) return;
    setActiveRecognitionPhotoId('inventory');
    setError('');
    try {
      const result = await api<{ project: { revision: number }; deletedInventoryId: string }>(
        `/projects/${projectId}/hardware-inventory/${encodeURIComponent(itemId)}`,
        { method: 'DELETE', body: { expectedRevision: revision } },
      );
      setInventory((previous) => previous.filter((item) => item.id !== result.deletedInventoryId));
      onRevision(result.project.revision);
    } catch (cause) {
      setError(friendlyError(cause));
      try {
        const latest = await api<ProjectDetail>(`/projects/${projectId}`);
        onRevision(latest.project.revision);
      } catch {
        // Keep the latest known revision until refresh.
      }
    } finally {
      setActiveRecognitionPhotoId('');
    }
  }

  async function linkInventoryItem(item: HardwareInventoryItem) {
    const componentInstanceId = componentSelections[item.id] ?? item.linkedComponentId ?? '';
    if (!editable || !circuit || !componentInstanceId || activeRecognitionPhotoId) return;
    setActiveRecognitionPhotoId(`link:${item.id}`);
    setError('');
    try {
      const result = await api<{ project: { revision: number } }>(
        `/projects/${projectId}/hardware-inventory/${encodeURIComponent(item.id)}/link`,
        {
          method: 'PUT',
          body: {
            expectedRevision: revision,
            graphSnapshotId: circuit.snapshotId,
            componentInstanceId,
          },
        },
      );
      setInventory((items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                linkedComponentId: componentInstanceId,
                linkedGraphSnapshotId: circuit.snapshotId,
              }
            : candidate,
        ),
      );
      onRevision(result.project.revision);
      setStatus('Confirmed hardware is linked to the selected virtual circuit component.');
    } catch (cause) {
      setError(friendlyError(cause));
      try {
        const latest = await api<ProjectDetail>(`/projects/${projectId}`);
        onRevision(latest.project.revision);
      } catch {
        // Keep the latest known revision until refresh.
      }
    } finally {
      setActiveRecognitionPhotoId('');
    }
  }

  async function unlinkInventoryItem(item: HardwareInventoryItem) {
    if (!editable || !item.linkedComponentId || activeRecognitionPhotoId) return;
    setActiveRecognitionPhotoId(`link:${item.id}`);
    setError('');
    try {
      const result = await api<{ project: { revision: number } }>(
        `/projects/${projectId}/hardware-inventory/${encodeURIComponent(item.id)}/link`,
        { method: 'DELETE', body: { expectedRevision: revision } },
      );
      setInventory((items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? { ...candidate, linkedComponentId: null, linkedGraphSnapshotId: null }
            : candidate,
        ),
      );
      setComponentSelections((selections) => ({ ...selections, [item.id]: '' }));
      onRevision(result.project.revision);
      setStatus('Hardware-to-component link removed.');
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setActiveRecognitionPhotoId('');
    }
  }

  return (
    <section className="hardware-photo-panel" aria-labelledby="hardware-photo-title">
      <div className="hardware-photo-heading">
        <div>
          <span className="eyebrow">PHASE 7 · HARDWARE PHOTO EVIDENCE</span>
          <h2 id="hardware-photo-title">
            <Camera size={18} /> Photos &amp; recognition
          </h2>
          <p>
            Keep reference photos with this project. A person must identify and confirm the exact
            hardware.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => void loadPhotos()}
          disabled={loading || uploading}
          aria-label="Refresh hardware photos"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="hardware-photo-boundary" role="note">
        Photos are private project evidence. Saving a photo stores it in this project only. A remote
        provider receives an image only after you consent for that specific photo and submit it. A
        visual suggestion does not verify pin mappings, electrical properties, or physical safety.
      </div>

      <form className="hardware-photo-upload" onSubmit={uploadFiles}>
        <label className="hardware-photo-picker">
          <ImagePlus size={17} />
          <span>
            {files.length
              ? `${files.length} photo${files.length === 1 ? '' : 's'} selected`
              : 'Choose photos'}
          </span>
          <input
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            multiple
            disabled={!editable || uploading}
            onChange={(event) => {
              selectFiles(event.target.files);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <label className="hardware-photo-role">
          Photo type
          <select
            value={shotRole}
            onChange={(event) => setShotRole(event.target.value as ShotRole)}
            disabled={uploading}
          >
            {Object.entries(shotRoleLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          type="submit"
          disabled={!editable || uploading || !files.length || !consent}
        >
          {uploading ? (
            <>
              <LoaderCircle className="hardware-photo-spinner" size={15} /> Saving…
            </>
          ) : (
            <>
              <Upload size={15} /> Save photos
            </>
          )}
        </button>
      </form>

      {files.length > 0 && (
        <ul className="hardware-photo-pending" aria-label="Selected photos">
          {files.map((file) => (
            <li key={`${file.name}-${file.lastModified}-${file.size}`}>
              {file.name}
              <small>{(file.size / (1024 * 1024)).toFixed(2)} MiB</small>
            </li>
          ))}
        </ul>
      )}
      <label className="hardware-photo-consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          disabled={!editable || uploading}
        />
        <span>
          I consent to storing these photos privately with this project as evidence for manual
          review.
        </span>
      </label>
      {uploading && (
        <div className="hardware-photo-progress" role="status">
          <progress
            aria-label="Photo upload progress"
            value={uploadPercent ?? undefined}
            max="100"
          />{' '}
          <span>
            {uploadPercent === null ? 'Preparing photo…' : `${uploadPercent}% · ${activeFile}`}
          </span>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="hardware-photo-status" role="status">
          {status}
        </p>
      )}

      <div className="hardware-photo-list-heading">
        <h3>Saved photos</h3>
        <span>{photos.length}</span>
      </div>
      {loading ? (
        <p className="fine-text">Loading saved photos…</p>
      ) : photos.length ? (
        <div className="hardware-photo-grid">
          {photos.map((photo) => (
            <article className="hardware-photo-card" key={photo.id}>
              <Image
                src={`/api/backend/v1/projects/${encodeURIComponent(projectId)}/hardware-photos/${encodeURIComponent(photo.id)}/content`}
                alt={`${shotRoleLabels[photo.shotRole]} photo, ${photo.width} by ${photo.height} pixels`}
                width={photo.width}
                height={photo.height}
                unoptimized
                loading="lazy"
              />
              <div className="hardware-photo-card-info">
                <strong>{shotRoleLabels[photo.shotRole]}</strong>
                <span>
                  {photo.width} × {photo.height} · {(photo.byteLength / (1024 * 1024)).toFixed(2)}{' '}
                  MiB
                </span>
                <small>
                  Manual review pending · {new Date(photo.createdAt).toLocaleDateString()}
                </small>
                {recognitionCapability?.enabled && editable && (
                  <div className="hardware-recognition-control">
                    <label
                      className="hardware-photo-consent"
                      htmlFor={`recognition-consent-${photo.id}`}
                    >
                      <input
                        id={`recognition-consent-${photo.id}`}
                        type="checkbox"
                        checked={recognitionConsent[photo.id] ?? false}
                        onChange={(event) =>
                          setRecognitionConsent((previous) => ({
                            ...previous,
                            [photo.id]: event.target.checked,
                          }))
                        }
                        disabled={Boolean(activeRecognitionPhotoId)}
                      />
                      <span>
                        I agree to send this photo to Vultr Serverless Inference using{' '}
                        {recognitionCapability.modelId} for visual hardware candidate suggestions.
                        Vultr states inference data is processed in memory and not persistently
                        stored by default; service terms apply. A request already in progress cannot
                        be recalled. Deleting the photo cancels queued work and removes stored
                        evidence and results.{' '}
                        <a
                          href="https://docs.vultr.com/support/products/serverless/how-secure-is-my-data-using-vultr-serverless-inference"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Review provider data handling
                        </a>
                      </span>
                    </label>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => void requestRecognition(photo)}
                      disabled={!recognitionConsent[photo.id] || Boolean(activeRecognitionPhotoId)}
                    >
                      {activeRecognitionPhotoId === photo.id ? (
                        <LoaderCircle className="hardware-photo-spinner" size={14} />
                      ) : (
                        <ScanSearch size={14} />
                      )}
                      Send for visual suggestions
                    </button>
                  </div>
                )}
                {recognitions
                  .filter((item) => item.photoId === photo.id)
                  .slice(0, 1)
                  .map((recognition) => (
                    <div className="hardware-recognition-result" key={recognition.id}>
                      <strong>
                        {recognition.status === 'queued'
                          ? 'Waiting for recognition…'
                          : recognition.status === 'running'
                            ? 'Reviewing this image…'
                            : recognition.status === 'failed'
                              ? 'Recognition could not complete.'
                              : recognition.status === 'cancelled'
                                ? 'Recognition was cancelled.'
                                : `Suggestion: ${recognition.proposal?.outcome ?? 'unavailable'}`}
                      </strong>
                      {recognition.status === 'completed' && recognition.proposal && (
                        <>
                          {recognition.proposal.observations.length > 0 && (
                            <div>
                              <small>Visible markings</small>
                              <ul>
                                {recognition.proposal.observations.map((observation, index) => (
                                  <li key={`${observation.text}-${index}`}>
                                    “{observation.text}”
                                    {observation.region &&
                                      ` · image area ${Math.round(observation.region.x * 100)}%, ${Math.round(observation.region.y * 100)}%`}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {recognition.proposal.candidates.map((candidate) => {
                            const part = catalogParts[candidate.catalogPartId];
                            return (
                              <div
                                className="hardware-recognition-candidate"
                                key={candidate.catalogPartId}
                              >
                                <span>
                                  {candidate.rank}.{' '}
                                  {part
                                    ? `${part.manufacturer} ${part.model}`
                                    : candidate.catalogPartId}
                                </span>
                                <small>{candidate.basis}</small>
                                {editable &&
                                  part &&
                                  !inventory.some(
                                    (item) => item.sourceRecognitionId === recognition.id,
                                  ) && (
                                    <button
                                      className="hardware-photo-delete hardware-inventory-confirm"
                                      type="button"
                                      onClick={() =>
                                        void confirmCandidate(recognition, candidate.catalogPartId)
                                      }
                                      disabled={Boolean(activeRecognitionPhotoId)}
                                    >
                                      <CheckCircle2 size={14} /> Confirm exact catalog part
                                    </button>
                                  )}
                              </div>
                            );
                          })}
                          {recognition.proposal.limitations.map((limitation, index) => (
                            <small key={`${recognition.id}-limitation-${index}`}>
                              {limitation}
                            </small>
                          ))}
                        </>
                      )}
                    </div>
                  ))}
                {editable && (
                  <button
                    className="hardware-photo-delete"
                    type="button"
                    onClick={() => void deletePhoto(photo)}
                    disabled={uploading || Boolean(deletingPhotoId)}
                    aria-label={`Delete ${shotRoleLabels[photo.shotRole]} photo`}
                  >
                    {deletingPhotoId === photo.id ? (
                      <LoaderCircle className="hardware-photo-spinner" size={14} />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    {deletingPhotoId === photo.id ? 'Removing…' : 'Delete photo'}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="fine-text">No hardware photos have been saved to this project.</p>
      )}
      {recognitionCapability && !recognitionCapability.enabled && (
        <p className="fine-text" role="status">
          Remote recognition is not enabled for this workspace. Saved photos remain available for
          manual review.
        </p>
      )}
      {inventory.length > 0 && (
        <div className="hardware-inventory">
          <h3>Confirmed project hardware</h3>
          <ul>
            {inventory.map((item) => {
              const part = catalogParts[item.catalogPartId];
              return (
                <li key={item.id}>
                  <strong>{item.label}</strong>
                  <span>{part?.category ?? item.catalogPartId}</span>
                  <small>Confirmed {new Date(item.confirmedAt).toLocaleDateString()}</small>
                  {editable && (
                    <>
                      {circuit ? (
                        <div className="hardware-inventory-link">
                          <label>
                            Virtual circuit component
                            <select
                              aria-label={`Virtual circuit component for ${item.label}`}
                              value={componentSelections[item.id] ?? item.linkedComponentId ?? ''}
                              onChange={(event) =>
                                setComponentSelections((selections) => ({
                                  ...selections,
                                  [item.id]: event.target.value,
                                }))
                              }
                              disabled={Boolean(activeRecognitionPhotoId)}
                            >
                              <option value="">Choose a matching component</option>
                              {circuit.components
                                .filter(
                                  (component) => component.catalogPartId === item.catalogPartId,
                                )
                                .filter(
                                  (component) =>
                                    !inventory.some(
                                      (other) =>
                                        other.id !== item.id &&
                                        other.linkedComponentId === component.id,
                                    ),
                                )
                                .map((component) => (
                                  <option key={component.id} value={component.id}>
                                    {component.id}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {item.linkedComponentId &&
                            item.linkedGraphSnapshotId !== circuit.snapshotId && (
                              <small role="status">Circuit changed; review this mapping.</small>
                            )}
                          {item.linkedComponentId &&
                            item.linkedGraphSnapshotId === circuit.snapshotId && (
                              <small>Linked to {item.linkedComponentId}</small>
                            )}
                          <div className="hardware-inventory-actions">
                            <button
                              className="hardware-photo-delete hardware-inventory-confirm"
                              type="button"
                              onClick={() => void linkInventoryItem(item)}
                              disabled={
                                Boolean(activeRecognitionPhotoId) ||
                                (!componentSelections[item.id] && !item.linkedComponentId)
                              }
                            >
                              {item.linkedComponentId ? 'Save mapping' : 'Link component'}
                            </button>
                            {item.linkedComponentId && (
                              <button
                                className="hardware-photo-delete"
                                type="button"
                                onClick={() => void unlinkInventoryItem(item)}
                                disabled={Boolean(activeRecognitionPhotoId)}
                              >
                                Remove link
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <small>No saved circuit is available to link this hardware.</small>
                      )}
                      <button
                        className="hardware-photo-delete"
                        type="button"
                        onClick={() => void removeInventoryItem(item.id)}
                        disabled={Boolean(activeRecognitionPhotoId)}
                      >
                        <Trash2 size={14} /> Remove from inventory
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
