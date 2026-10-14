'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Camera, ImagePlus, LoaderCircle, RefreshCw, Upload } from 'lucide-react';
import { api, friendlyError, type ProjectDetail } from '@/lib/api';

const PHOTO_LIMIT_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CONSENT_VERSION = 'photo-evidence-v1' as const;

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
  const [files, setFiles] = useState<File[]>([]);
  const [shotRole, setShotRole] = useState<ShotRole>('board-top');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [activeFile, setActiveFile] = useState('');
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const idempotencyKeys = useRef(new WeakMap<File, string>());

  const loadPhotos = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const response = await api<PhotoList>(`/projects/${projectId}/hardware-photos`, { signal });
        if (!signal?.aborted) setPhotos(response.items);
      } catch (cause) {
        if (!signal?.aborted) setError(friendlyError(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadPhotos(controller.signal);
    return () => controller.abort();
  }, [loadPhotos]);

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
      setError(friendlyError(cause));
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
      void loadPhotos();
    } finally {
      setActiveFile('');
      setUploadPercent(null);
      setUploading(false);
    }
  }

  return (
    <section className="hardware-photo-panel" aria-labelledby="hardware-photo-title">
      <div className="hardware-photo-heading">
        <div>
          <span className="eyebrow">PHASE 7 · HARDWARE PHOTO EVIDENCE</span>
          <h2 id="hardware-photo-title">
            <Camera size={18} /> Photos for manual review
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
        Photos are private project evidence. They are reviewed manually; no automated recognition or
        provider is used. A photo does not verify the board model, pinout, electrical properties, or
        physical safety.
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
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="fine-text">No hardware photos have been saved to this project.</p>
      )}
    </section>
  );
}
