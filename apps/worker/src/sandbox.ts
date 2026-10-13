import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SandboxLimits {
  wallTimeoutMs: number;
  memoryBytes: number;
  cpuCount: number;
  pids: number;
  outputBytes: number;
  stdoutBytes: number;
}
export interface SandboxRequest {
  image: string;
  firmware: Uint8Array;
  limits: SandboxLimits;
}
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  files: Record<string, Uint8Array>;
}
export interface SandboxOptions {
  platform?: string;
  uid?: number;
  docker?: string;
  tempRoot?: string;
  spawn?: typeof nodeSpawn;
  removeWorkspace?: (path: string) => Promise<void>;
}

const immutableImage = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const fixedEntrypoint = '/usr/local/bin/schemora-simulator';
const fixedCommand = ['/input/firmware.bin', '/output'];
const safeFile = (name: string) =>
  name.length > 0 &&
  name.length <= 240 &&
  !name.startsWith('/') &&
  !name.includes('\\') &&
  name.split('/').length <= 8 &&
  name
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        part !== '__proto__' &&
        part !== 'constructor' &&
        part !== 'prototype',
    );

class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(
    private readonly max: number,
    private readonly overflow: () => void,
  ) {}
  push(value: Buffer | string) {
    const bytes = Buffer.from(value);
    const accepted = bytes.subarray(0, Math.max(0, this.max - this.size));
    if (accepted.length) {
      this.chunks.push(accepted);
      this.size += accepted.length;
    }
    if (accepted.length !== bytes.length) this.overflow();
  }
  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function invoke(
  spawn: typeof nodeSpawn,
  binary: string,
  args: string[],
  timeoutMs: number,
  cap = 64 * 1024,
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, reject) => {
    let done = false;
    let child: ChildProcess;
    const stop = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* process already exited */
      }
    };
    const finish = (error?: Error, code = 0) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise({ code, stdout: stdout.text(), stderr: stderr.text() });
    };
    const overflow = () => {
      stop();
      finish(new Error('SANDBOX_OUTPUT_LIMIT'));
    };
    const stdout = new BoundedBuffer(cap, overflow),
      stderr = new BoundedBuffer(cap, overflow);
    const timer = setTimeout(() => {
      stop();
      finish(new Error('SANDBOX_COMMAND_TIMEOUT'));
    }, timeoutMs);
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
      });
    } catch {
      finish(new Error('SANDBOX_DOCKER_UNAVAILABLE'));
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', () => finish(new Error('SANDBOX_DOCKER_UNAVAILABLE')));
    child.once('close', (code) => finish(undefined, code ?? 1));
  });
}

export class DockerSandbox {
  private readonly spawn: typeof nodeSpawn;
  private readonly docker: string;
  private readonly tempRoot: string;
  private readonly platform: string;
  private readonly uid: number;
  private readonly removeWorkspace: (path: string) => Promise<void>;
  constructor(options: SandboxOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.docker = options.docker ?? 'docker';
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.platform = options.platform ?? process.platform;
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.removeWorkspace =
      options.removeWorkspace ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  async preflight(image: string): Promise<void> {
    if (this.platform !== 'linux' || this.uid <= 0) throw new Error('SANDBOX_HOST_UNSUPPORTED');
    if (!immutableImage.test(image)) throw new Error('SANDBOX_IMAGE_NOT_PINNED');
    const info = await invoke(this.spawn, this.docker, ['info', '--format', '{{json .}}'], 5000);
    if (info.code !== 0) throw new Error('SANDBOX_DAEMON_UNAVAILABLE');
    let data: {
      SecurityOptions?: string[];
      OSType?: string;
      ServerVersion?: string;
      CgroupVersion?: string;
    };
    try {
      data = JSON.parse(info.stdout) as typeof data;
    } catch {
      throw new Error('SANDBOX_DAEMON_UNVERIFIABLE');
    }
    if (data.OSType !== 'linux' || !data.ServerVersion)
      throw new Error('SANDBOX_DAEMON_UNSUPPORTED');
    if (!(data.SecurityOptions ?? []).some((option) => option.toLowerCase().includes('rootless')))
      throw new Error('SANDBOX_ROOTLESS_REQUIRED');
    if (data.CgroupVersion !== '2') throw new Error('SANDBOX_CGROUP_UNSUPPORTED');
    const inspected = await invoke(
      this.spawn,
      this.docker,
      ['image', 'inspect', image, '--format', '{{json .}}'],
      5000,
    );
    if (inspected.code !== 0) throw new Error('SANDBOX_IMAGE_UNAVAILABLE');
    let imageMetadata: { Id?: string; Config?: { Volumes?: Record<string, unknown> | null } };
    try {
      imageMetadata = JSON.parse(inspected.stdout) as typeof imageMetadata;
    } catch {
      throw new Error('SANDBOX_IMAGE_UNVERIFIABLE');
    }
    if (!imageMetadata.Id?.startsWith('sha256:')) throw new Error('SANDBOX_IMAGE_UNAVAILABLE');
    if (Object.keys(imageMetadata.Config?.Volumes ?? {}).length > 0)
      throw new Error('SANDBOX_IMAGE_DECLARED_MOUNTS');
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    this.validateLimits(request.limits);
    if (request.firmware.byteLength < 1 || request.firmware.byteLength > 2_000_000)
      throw new Error('SANDBOX_FIRMWARE_SIZE_INVALID');
    await this.preflight(request.image);
    const work = await mkdtemp(join(this.tempRoot, 'schemora-sandbox-'));
    const inputDir = join(work, 'input');
    const outputDir = join(work, 'output');
    const inputPath = join(inputDir, 'firmware.bin');
    const id = `schemora-${randomUUID()}`;
    let created = false;
    try {
      await Promise.all([mkdir(inputDir, { mode: 0o700 }), mkdir(outputDir, { mode: 0o700 })]);
      await writeFile(inputPath, request.firmware, { mode: 0o444, flag: 'wx' });
      const args = [
        'create',
        '--pull=never',
        '--name',
        id,
        '--network=none',
        '--read-only',
        '--user',
        '65532:65532',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        '--security-opt=seccomp=builtin',
        '--cpus',
        String(request.limits.cpuCount),
        '--memory',
        String(request.limits.memoryBytes),
        '--memory-swap',
        String(request.limits.memoryBytes),
        '--pids-limit',
        String(request.limits.pids),
        '--tmpfs',
        `/output:rw,noexec,nosuid,nodev,size=${request.limits.outputBytes},uid=65532,gid=65532,mode=0700`,
        '--mount',
        `type=bind,src=${resolve(inputPath)},dst=/input/firmware.bin,readonly`,
        '--workdir',
        '/output',
        '--entrypoint',
        fixedEntrypoint,
        request.image,
        ...fixedCommand,
      ];
      const create = await invoke(this.spawn, this.docker, args, 10_000);
      if (create.code !== 0) throw new Error('SANDBOX_CREATE_FAILED');
      created = true;
      const configured = await invoke(
        this.spawn,
        this.docker,
        ['inspect', '--format', '{{json .}}', id],
        5000,
      );
      if (configured.code !== 0) throw new Error('SANDBOX_CONTROLS_UNVERIFIABLE');
      this.verifyContainerControls(configured.stdout, request.limits);
      const start = await invoke(
        this.spawn,
        this.docker,
        ['start', '--attach', id],
        request.limits.wallTimeoutMs,
        request.limits.stdoutBytes,
      );
      let result = start;
      if (start.code === 125 || start.code === 126 || start.code === 127)
        throw new Error('SANDBOX_START_FAILED');
      const copy = await invoke(
        this.spawn,
        this.docker,
        ['cp', `${id}:/output/.`, outputDir],
        10_000,
        4096,
      );
      if (copy.code !== 0) throw new Error('SANDBOX_OUTPUT_UNAVAILABLE');
      const files = await this.readOutputs(outputDir, request.limits.outputBytes);
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, files };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SANDBOX_')) throw error;
      throw new Error('SANDBOX_EXECUTION_FAILED');
    } finally {
      let cleanupFailed = false;
      if (created) {
        try {
          const removed = await invoke(this.spawn, this.docker, ['rm', '--force', id], 5000);
          if (removed.code !== 0) cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await this.removeWorkspace(work);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) throw new Error('SANDBOX_CLEANUP_FAILED');
    }
  }

  private validateLimits(limits: SandboxLimits) {
    if (
      !Number.isSafeInteger(limits.wallTimeoutMs) ||
      limits.wallTimeoutMs < 1000 ||
      limits.wallTimeoutMs > 120_000 ||
      !Number.isSafeInteger(limits.memoryBytes) ||
      limits.memoryBytes < 64 * 1024 * 1024 ||
      limits.memoryBytes > 2 * 1024 ** 3 ||
      !Number.isFinite(limits.cpuCount) ||
      limits.cpuCount <= 0 ||
      limits.cpuCount > 2 ||
      !Number.isSafeInteger(limits.pids) ||
      limits.pids < 16 ||
      limits.pids > 256 ||
      !Number.isSafeInteger(limits.outputBytes) ||
      limits.outputBytes < 1024 ||
      limits.outputBytes > 2_000_000 ||
      !Number.isSafeInteger(limits.stdoutBytes) ||
      limits.stdoutBytes < 1024 ||
      limits.stdoutBytes > 1_000_000
    )
      throw new Error('SANDBOX_LIMITS_INVALID');
  }

  private verifyContainerControls(raw: string, limits: SandboxLimits) {
    let inspected: {
      HostConfig?: {
        NetworkMode?: string;
        ReadonlyRootfs?: boolean;
        Memory?: number;
        MemorySwap?: number;
        NanoCpus?: number;
        PidsLimit?: number;
        CapDrop?: string[];
        SecurityOpt?: string[];
        Tmpfs?: Record<string, string>;
        Binds?: string[];
        Privileged?: boolean;
        PidMode?: string;
        IpcMode?: string;
        Devices?: unknown[];
        DeviceRequests?: unknown[];
      };
      Config?: { User?: string; Entrypoint?: string[]; Cmd?: string[] };
      Mounts?: Array<{ Type?: string; Destination?: string; RW?: boolean }>;
    };
    try {
      inspected = JSON.parse(raw) as typeof inspected;
    } catch {
      throw new Error('SANDBOX_CONTROLS_UNVERIFIABLE');
    }
    const host = inspected.HostConfig ?? {};
    const outputTmpfs = host.Tmpfs?.['/output'] ?? '';
    const tmpfsOptions = new Set(outputTmpfs.split(','));
    const mounts = inspected.Mounts ?? [];
    const expectedMounts =
      mounts.length === 2 &&
      mounts.some(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Destination === '/input/firmware.bin' &&
          mount.RW === false,
      ) &&
      mounts.some(
        (mount) => mount.Type === 'tmpfs' && mount.Destination === '/output' && mount.RW === true,
      );
    const verified =
      host.NetworkMode === 'none' &&
      host.ReadonlyRootfs === true &&
      host.Memory === limits.memoryBytes &&
      host.MemorySwap === limits.memoryBytes &&
      host.NanoCpus === Math.round(limits.cpuCount * 1_000_000_000) &&
      host.PidsLimit === limits.pids &&
      host.CapDrop?.some((cap) => cap.toUpperCase() === 'ALL') === true &&
      host.SecurityOpt?.some((opt) => opt === 'no-new-privileges:true') === true &&
      host.SecurityOpt?.some((opt) => opt === 'seccomp=builtin') === true &&
      tmpfsOptions.has('noexec') &&
      tmpfsOptions.has('nosuid') &&
      tmpfsOptions.has('nodev') &&
      tmpfsOptions.has(`size=${limits.outputBytes}`) &&
      tmpfsOptions.has('uid=65532') &&
      tmpfsOptions.has('gid=65532') &&
      tmpfsOptions.has('mode=0700') &&
      host.Binds?.length === 1 &&
      host.Binds[0]?.includes(':/input/firmware.bin:ro') &&
      host.Privileged === false &&
      (host.PidMode === undefined || host.PidMode === '' || host.PidMode === 'private') &&
      (host.IpcMode === undefined || host.IpcMode === '' || host.IpcMode === 'private') &&
      (host.Devices?.length ?? 0) === 0 &&
      (host.DeviceRequests?.length ?? 0) === 0 &&
      inspected.Config?.User === '65532:65532' &&
      inspected.Config?.Entrypoint?.length === 1 &&
      inspected.Config.Entrypoint[0] === fixedEntrypoint &&
      inspected.Config?.Cmd?.join('\0') === fixedCommand.join('\0') &&
      expectedMounts;
    if (!verified) throw new Error('SANDBOX_CONTROLS_UNAVAILABLE');
  }

  private async readOutputs(directory: string, maxBytes: number) {
    const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    let total = 0;
    let fileCount = 0;
    const visit = async (current: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!safeFile(relative)) throw new Error('SANDBOX_OUTPUT_INVALID');
        const path = join(current, entry.name);
        const meta = await lstat(path);
        if (meta.isSymbolicLink() || entry.isSymbolicLink())
          throw new Error('SANDBOX_OUTPUT_INVALID');
        if (entry.isDirectory()) await visit(path, relative);
        else if (entry.isFile()) {
          fileCount += 1;
          if (fileCount > 256) throw new Error('SANDBOX_OUTPUT_LIMIT');
          total += meta.size;
          if (total > maxBytes) throw new Error('SANDBOX_OUTPUT_LIMIT');
          files[relative] = await readFile(path);
        } else throw new Error('SANDBOX_OUTPUT_INVALID');
      }
    };
    await visit(directory, '');
    return files;
  }
}
