import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  conversationBundleSchema,
  extractionResultSchema,
  type ConversationBundle,
  type ExtractionResult,
  type NormalizedConversation,
} from '@schemora/contracts';
import { extractCandidates, createModelExtractor } from '@schemora/intelligence';
import { Repository, requestDigest, type Job, type ImportRow } from '@schemora/persistence';
import {
  simulationBindingSchema,
  simulationRunSchema,
  unavailableSimulationRun,
} from '@schemora/simulation';
import type { PrivateStorage } from '@schemora/storage';

export function isolatedParse(filename: string, bytes: Uint8Array) {
  return new Promise<{ bundle: ConversationBundle; extraction: ExtractionResult | null }>(
    (resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./processor.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx', '--max-old-space-size=256'],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { PATH: process.env.PATH, NODE_ENV: 'production', SYSTEMROOT: process.env.SYSTEMROOT },
      });
      let settled = false;
      const finish = (
        error?: Error,
        output?: { bundle: ConversationBundle; extraction: ExtractionResult | null },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error);
        else resolve(output!);
      };
      const timer = setTimeout(() => finish(new Error('SOURCE_PROCESSING_TIMEOUT')), 30_000);
      child.once('message', (value: unknown) => {
        try {
          const result = value as { ok?: boolean; bundle?: unknown; extraction?: unknown };
          if (!result.ok) {
            finish(new Error('UNSUPPORTED_OR_INVALID_SOURCE'));
            return;
          }
          finish(undefined, {
            bundle: conversationBundleSchema.parse(result.bundle),
            extraction: result.extraction ? extractionResultSchema.parse(result.extraction) : null,
          });
        } catch {
          finish(new Error('INVALID_PROCESSOR_OUTPUT'));
        }
      });
      child.once('error', () => finish(new Error('PROCESSOR_UNAVAILABLE')));
      child.once('exit', () => {
        if (!settled) finish(new Error('PROCESSOR_UNAVAILABLE'));
      });
      child.send({ filename, bytes });
    },
  );
}

export interface ExtractorConfig {
  mode: 'rules' | 'provider';
  endpoint?: string;
  apiKey?: string;
  model?: string;
  extract?: (conversation: NormalizedConversation) => Promise<ExtractionResult>;
}
export class Worker {
  constructor(
    private readonly repository: Repository,
    private readonly storage: PrivateStorage,
    private readonly extraction: ExtractorConfig = { mode: 'rules' },
    private readonly leaseSeconds = 120,
  ) {}
  async tick(kind: Job['kind']) {
    await this.repository.cleanupUploadIntents((key) => this.storage.delete(key));
    await this.repository.dispatch();
    await this.repository.reapExpired();
    const job = await this.repository.claim(kind, this.leaseSeconds);
    if (!job) return false;
    const startedAt = Date.now();
    let renewing: Promise<boolean> | null = null;
    const heartbeat = setInterval(
      () => {
        if (!renewing)
          renewing = this.repository
            .renewLease(job, this.leaseSeconds)
            .catch(() => false)
            .finally(() => {
              renewing = null;
            });
      },
      Math.max(50, (this.leaseSeconds * 1000) / 3),
    );
    try {
      if (kind === 'delete_project') await this.deleteProject(job);
      else if (kind === 'simulate_run') await this.settleSimulationUnavailable(job);
      else await this.processImport(job);
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'PROCESSING_UNAVAILABLE';
      await this.repository.fail(
        job,
        code,
        ![
          'UNSUPPORTED_OR_INVALID_SOURCE',
          'INVALID_PROCESSOR_OUTPUT',
          'INVALID_JOB_PAYLOAD',
          'SIMULATION_RUN_NOT_FOUND',
        ].includes(code),
      );
    } finally {
      clearInterval(heartbeat);
      if (renewing) await renewing;
      if (process.env.NODE_ENV !== 'test') {
        const state = await this.repository.pool
          .query('SELECT status,error_code FROM jobs WHERE id=$1', [job.id])
          .catch(() => null);
        console.log(
          JSON.stringify({
            event: 'worker_job_settled',
            jobId: job.id,
            kind,
            attempt: job.attempts,
            status: state?.rows[0]?.status ?? 'unavailable',
            errorCode: state?.rows[0]?.error_code ?? null,
            durationMs: Date.now() - startedAt,
          }),
        );
      }
    }
    return true;
  }
  async settleSimulationUnavailable(job: Job) {
    if (job.kind !== 'simulate_run') throw new Error('INVALID_JOB_PAYLOAD');
    const runId = job.payload.runId;
    if (!runId) throw new Error('INVALID_JOB_PAYLOAD');

    await this.repository.transaction(async (client) => {
      const project = await this.repository.jobScope(client, job);
      if (!project) return;

      const selected = await client.query<{
        status: string;
        binding: unknown;
      }>('SELECT status,binding FROM simulation_runs WHERE id=$1 AND project_id=$2 FOR UPDATE', [
        runId,
        job.project_id,
      ]);
      const stored = selected.rows[0];
      if (!stored) throw new Error('SIMULATION_RUN_NOT_FOUND');

      const completeJob = project.status === 'active' ? 'completed' : 'cancelled';
      if (stored.status !== 'queued') {
        await client.query(
          "UPDATE jobs SET status=$3,payload='{}'::jsonb,lease_until=NULL,lease_token=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",
          [job.id, job.lease_token, completeJob],
        );
        return;
      }

      const binding = simulationBindingSchema.parse(stored.binding);
      const unavailable = unavailableSimulationRun({
        runId,
        binding,
        reason: 'No approved simulation provider is configured.',
      });
      const terminalRun =
        project.status === 'active'
          ? unavailable
          : simulationRunSchema.parse({
              ...unavailable,
              status: 'cancelled',
              failure: {
                code: 'CANCELLED',
                message: 'Run cancelled because the project is no longer active.',
              },
              simulatedDurationMs: 0,
            });

      await client.query(
        "UPDATE simulation_runs SET status=$3,run=$4::jsonb,updated_at=now() WHERE id=$1 AND project_id=$2 AND status='queued'",
        [runId, job.project_id, terminalRun.status, JSON.stringify(terminalRun)],
      );
      await client.query(
        "UPDATE jobs SET status=$3,payload='{}'::jsonb,lease_until=NULL,lease_token=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",
        [job.id, job.lease_token, completeJob],
      );
    });
  }
  async processImport(job: Job) {
    if (!job.payload.importId) throw new Error('INVALID_JOB_PAYLOAD');
    const source = await this.repository.transaction(async (client) => {
      const project = await this.repository.jobScope(client, job);
      if (!project || project.status !== 'active') {
        await client.query("UPDATE jobs SET status='cancelled' WHERE id=$1 AND lease_token=$2", [
          job.id,
          job.lease_token,
        ]);
        return null;
      }
      const source = await this.repository.import(client, job.project_id, job.payload.importId!);
      if (!['queued', 'processing'].includes(source.status)) {
        await client.query("UPDATE jobs SET status='completed' WHERE id=$1 AND lease_token=$2", [
          job.id,
          job.lease_token,
        ]);
        return null;
      }
      await client.query("UPDATE imports SET status='processing' WHERE id=$1", [source.id]);
      return source;
    });
    if (!source) return;
    let bundle = source.bundle;
    let extracted: ExtractionResult | null = null;
    if (!bundle) {
      const bytes = await this.storage.read(source.object_key, source.source_digest);
      const parsed = await isolatedParse(source.filename, bytes);
      bundle = parsed.bundle;
      extracted = parsed.extraction;
    }
    const selectedId =
      source.selected_conversation_id ??
      (bundle.conversations.length === 1 ? bundle.conversations[0]!.id : null);
    const conversation = bundle.conversations.find((item) => item.id === selectedId);
    let actualMode: 'deterministic' | 'provider' = 'deterministic';
    if (conversation) {
      if (this.extraction.mode === 'provider') {
        try {
          const extractor =
            this.extraction.extract ??
            createModelExtractor({
              endpoint: this.extraction.endpoint!,
              apiKey: this.extraction.apiKey!,
              model: this.extraction.model!,
              timeoutMs: 30_000,
            });
          extracted = await extractor(conversation);
          actualMode = 'provider';
        } catch {
          extracted = extractCandidates(conversation);
          conversation.warnings.push(
            'Automatic model extraction was unavailable. This review uses conservative source rules and needs your verification; it may miss design facts.',
          );
        }
      } else extracted = extracted ?? extractCandidates(conversation);
    }
    await this.repository.transaction(async (client) => {
      const project = await this.repository.jobScope(client, job);
      if (!project || project.status !== 'active') return;
      const current = await this.repository.import(client, job.project_id, source.id);
      if (
        current.status !== 'processing' ||
        current.selected_conversation_id !== source.selected_conversation_id
      )
        return;
      const parserVersion = 'schemora-import-0.1.0';
      const extractorVersion =
        actualMode === 'provider' ? 'schemora-provider-0.1.0' : 'schemora-rules-0.1.0';
      const metadata = {
        sourceDigest: source.source_digest,
        parserVersion,
        normalizerSchema: 1,
        extractorVersion,
        providerModel:
          actualMode === 'provider' ? (this.extraction.model ?? 'test-injected') : null,
        promptVersion: actualMode === 'provider' ? 'source-extraction-v1' : null,
        extractionSchema: 1,
      };
      const bundleMetadata = {
        sourceDigest: source.source_digest,
        parserVersion,
        normalizerSchema: 1,
      };
      const bundleDigest = requestDigest({ payload: bundle, metadata: bundleMetadata });
      const extractionDigest = extracted ? requestDigest({ payload: extracted, metadata }) : null;
      await client.query(
        "INSERT INTO import_artifacts(project_id,digest,kind,payload,metadata) VALUES($1,$2,'bundle',$3,$4) ON CONFLICT DO NOTHING",
        [project.id, bundleDigest, JSON.stringify(bundle), JSON.stringify(bundleMetadata)],
      );
      if (extracted)
        await client.query(
          "INSERT INTO import_artifacts(project_id,digest,kind,payload,metadata) VALUES($1,$2,'extraction',$3,$4) ON CONFLICT DO NOTHING",
          [project.id, extractionDigest, JSON.stringify(extracted), JSON.stringify(metadata)],
        );
      await client.query(
        'UPDATE imports SET bundle=$2,extraction=$3,selected_conversation_id=$4,status=$5,error_code=NULL,bundle_digest=$6,extraction_digest=$7,extraction_mode=$8 WHERE id=$1',
        [
          source.id,
          JSON.stringify(bundle),
          extracted ? JSON.stringify(extracted) : null,
          selectedId,
          selectedId ? 'ready' : 'awaiting_selection',
          bundleDigest,
          extractionDigest,
          selectedId ? actualMode : null,
        ],
      );
      await client.query(
        'UPDATE imports SET parser_version=$2,normalizer_schema=1,extractor_version=$3,provider_model=$4,prompt_version=$5 WHERE id=$1',
        [
          source.id,
          parserVersion,
          selectedId ? extractorVersion : null,
          metadata.providerModel,
          metadata.promptVersion,
        ],
      );
      await client.query(
        "UPDATE jobs SET status='completed',lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token],
      );
      project.revision += 1;
      await client.query('UPDATE projects SET revision=$2,updated_at=now() WHERE id=$1', [
        project.id,
        project.revision,
      ]);
      project.updated_at = new Date();
      await this.repository.saveRevision(
        client,
        project,
        project.owner_id,
        selectedId ? 'import_ready' : 'import_selection_required',
      );
    });
  }
  async deleteProject(job: Job) {
    const sources = await this.repository.transaction(async (client) => {
      const project = await this.repository.jobScope(client, job);
      if (!project || project.status !== 'deleting') return null;
      return (
        await client.query<{ object_key: string }>(
          'SELECT object_key FROM imports WHERE project_id=$1 UNION SELECT object_key FROM firmware_artifacts WHERE project_id=$1 UNION SELECT object_key FROM firmware_artifact_files WHERE project_id=$1 UNION SELECT object_key FROM firmware_build_artifacts WHERE project_id=$1 UNION SELECT object_key FROM upload_intents WHERE project_id=$1',
          [job.project_id],
        )
      ).rows;
    });
    if (!sources) return;
    for (const source of sources) await this.storage.delete(source.object_key);
    // Fresh intents remain until their deadline: an in-flight put could complete after this purge.
    await this.repository.transaction(async (client) => {
      const project = await this.repository.jobScope(client, job);
      if (!project || project.status !== 'deleting') return;
      await client.query('DELETE FROM reviews WHERE project_id=$1', [job.project_id]);
      // The attempt ledger intentionally retains terminal rows during normal
      // operation, so purge its children before removing their run parents.
      await client.query('DELETE FROM simulation_run_attempts WHERE project_id=$1', [
        job.project_id,
      ]);
      await client.query('DELETE FROM simulation_runs WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM firmware_reviews WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM firmware_builds WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM firmware_artifacts WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM validation_reports WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM circuit_graph_snapshots WHERE project_id=$1', [
        job.project_id,
      ]);
      await client.query('DELETE FROM revisions WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM imports WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM import_artifacts WHERE project_id=$1', [job.project_id]);
      await client.query('DELETE FROM idempotency WHERE scope LIKE $1', [job.project_id + ':%']);
      // Project creation replay must not retain the deleted title or reopen the project.
      await client.query(
        "DELETE FROM idempotency WHERE scope='create_project' AND response->>'id'=$1",
        [job.project_id],
      );
      await client.query(
        "UPDATE outbox SET delivered_at=coalesce(delivered_at,now()),payload='{}'::jsonb WHERE project_id=$1",
        [job.project_id],
      );
      await client.query(
        "UPDATE jobs SET status=CASE WHEN id=$2 THEN 'completed' ELSE 'cancelled' END,payload='{}'::jsonb,lease_until=NULL,lease_token=NULL WHERE project_id=$1",
        [job.project_id, job.id],
      );
      await client.query(
        "UPDATE projects SET title='[deleted]',status='deleted',updated_at=now() WHERE id=$1",
        [job.project_id],
      );
    });
  }
}
