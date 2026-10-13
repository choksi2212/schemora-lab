import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lstat, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerSandbox, type SandboxLimits } from '../src/sandbox.js';

const image = `registry.example/sim@sha256:${'a'.repeat(64)}`;
const limits: SandboxLimits = {
  wallTimeoutMs: 10_000,
  memoryBytes: 128 * 1024 * 1024,
  cpuCount: 0.5,
  pids: 64,
  outputBytes: 2_000_000,
  stdoutBytes: 32_000,
};
const noSpawn = vi.fn(() => {
  throw new Error('unexpected spawn');
});
const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  noSpawn.mockClear();
});

function fakeDocker(
  info: Record<string, unknown>,
  calls: Array<{ args: string[]; options: unknown }>,
  outputSize = 11,
  resourceLimits = limits,
  failedCommands: string[] = [],
  inputModes?: number[],
  fileCount = 1,
  declaredVolumes: Record<string, unknown> | null = null,
  outputNames?: string[],
  containerOverrides?: {
    hostConfig?: Record<string, unknown>;
    mounts?: Array<{ Type: string; Destination: string; RW: boolean }>;
  },
) {
  return ((_: string, args: string[], options: unknown) => {
    calls.push({ args, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    queueMicrotask(async () => {
      const [subcommand] = args;
      if (subcommand === 'info') child.stdout.write(JSON.stringify(info));
      else if (subcommand === 'image')
        child.stdout.write(
          JSON.stringify({ Id: 'sha256:' + 'b'.repeat(64), Config: { Volumes: declaredVolumes } }),
        );
      else if (subcommand === 'create' && inputModes) {
        const mount = args[args.indexOf('--mount') + 1]!;
        const source = mount.split('src=')[1]?.split(',dst=')[0]!;
        inputModes.push((await lstat(source)).mode & 0o777);
      } else if (subcommand === 'inspect' && args[1] === '--format') {
        const mountIndex =
          calls.find((call) => call.args[0] === 'create')?.args.indexOf('--mount') ?? -1;
        const mount = calls.find((call) => call.args[0] === 'create')?.args[mountIndex + 1] ?? '';
        const bind = mount.split('src=')[1]?.split(',dst=')[0] ?? '';
        const hostConfig = {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          Memory: resourceLimits.memoryBytes,
          MemorySwap: resourceLimits.memoryBytes,
          NanoCpus: Math.round(resourceLimits.cpuCount * 1_000_000_000),
          PidsLimit: resourceLimits.pids,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true', 'seccomp=builtin'],
          Tmpfs: {
            '/output': `rw,noexec,nosuid,nodev,size=${resourceLimits.outputBytes},uid=65532,gid=65532,mode=0700`,
          },
          Binds: [`${bind}:/input/firmware.bin:ro`],
          Privileged: false,
          PidMode: '',
          IpcMode: '',
          Devices: [],
          DeviceRequests: [],
          ...containerOverrides?.hostConfig,
        };
        child.stdout.write(
          JSON.stringify({
            HostConfig: hostConfig,
            Config: {
              User: '65532:65532',
              Entrypoint: ['/usr/local/bin/schemora-simulator'],
              Cmd: ['/input/firmware.bin', '/output'],
            },
            Mounts: containerOverrides?.mounts ?? [
              { Type: 'bind', Destination: '/input/firmware.bin', RW: false },
              { Type: 'tmpfs', Destination: '/output', RW: true },
            ],
          }),
        );
      } else if (subcommand === 'start') child.stdout.write('simulator output');
      else if (subcommand === 'cp') {
        const output = args[2]!;
        await mkdir(output, { recursive: true });
        for (let index = 0; index < fileCount; index += 1) {
          const outputFile = join(
            output,
            outputNames?.[index] ?? (fileCount === 1 ? 'trace.json' : `empty-${index}.bin`),
          );
          await mkdir(dirname(outputFile), { recursive: true });
          await writeFile(
            outputFile,
            outputSize === 11
              ? fileCount === 1
                ? '{"ok":true}'
                : Buffer.alloc(0)
              : Buffer.alloc(outputSize, 120),
          );
        }
      }
      child.emit('close', failedCommands.includes(subcommand ?? '') ? 1 : 0);
    });
    return child;
  }) as never;
}

describe('DockerSandbox fail-closed preflight', () => {
  it('rejects non-Linux hosts before invoking Docker', async () => {
    const sandbox = new DockerSandbox({ platform: 'win32', uid: 1000, spawn: noSpawn as never });
    await expect(sandbox.preflight(image)).rejects.toThrow('SANDBOX_HOST_UNSUPPORTED');
    expect(noSpawn).not.toHaveBeenCalled();
  });

  it('rejects mutable tags before invoking Docker', async () => {
    const sandbox = new DockerSandbox({ platform: 'linux', uid: 1000, spawn: noSpawn as never });
    await expect(sandbox.preflight('registry.example/sim:latest')).rejects.toThrow(
      'SANDBOX_IMAGE_NOT_PINNED',
    );
    expect(noSpawn).not.toHaveBeenCalled();
  });

  it('rejects invalid or over-ceiling resource bounds before Docker', async () => {
    const sandbox = new DockerSandbox({ platform: 'linux', uid: 1000, spawn: noSpawn as never });
    await expect(
      sandbox.run({
        image,
        firmware: new Uint8Array([1]),
        limits: { ...limits, outputBytes: 2_000_001 },
      }),
    ).rejects.toThrow('SANDBOX_LIMITS_INVALID');
    expect(noSpawn).not.toHaveBeenCalled();
  });

  it('accepts an explicitly rootless Linux daemon on cgroup v2', async () => {
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      spawn: fakeDocker(
        {
          OSType: 'linux',
          ServerVersion: '27.0',
          CgroupVersion: '2',
          SecurityOptions: ['name=rootless'],
        },
        calls,
      ),
    });
    await expect(sandbox.preflight(image)).resolves.toBeUndefined();
    expect(calls.map((call) => call.args[0])).toEqual(['info', 'image']);
  });

  it('rejects a rootful Docker daemon', async () => {
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      spawn: fakeDocker(
        {
          OSType: 'linux',
          ServerVersion: '27.0',
          CgroupVersion: '2',
          SecurityOptions: ['name=seccomp'],
        },
        calls,
      ),
    });
    await expect(sandbox.preflight(image)).rejects.toThrow('SANDBOX_ROOTLESS_REQUIRED');
    expect(calls.map((call) => call.args[0])).toEqual(['info']);
  });

  it('rejects images that declare anonymous mount points', async () => {
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      spawn: fakeDocker(
        {
          OSType: 'linux',
          ServerVersion: '27.0',
          CgroupVersion: '2',
          SecurityOptions: ['name=rootless'],
        },
        calls,
        11,
        limits,
        [],
        undefined,
        1,
        { '/workspace': {} },
      ),
    });
    await expect(sandbox.preflight(image)).rejects.toThrow('SANDBOX_IMAGE_DECLARED_MOUNTS');
  });

  it('rejects firmware outside the supported size range before Docker', async () => {
    const sandbox = new DockerSandbox({ platform: 'linux', uid: 1000, spawn: noSpawn as never });
    await expect(sandbox.run({ image, firmware: new Uint8Array(), limits })).rejects.toThrow(
      'SANDBOX_FIRMWARE_SIZE_INVALID',
    );
    await expect(
      sandbox.run({ image, firmware: new Uint8Array(2_000_001), limits }),
    ).rejects.toThrow('SANDBOX_FIRMWARE_SIZE_INVALID');
    expect(noSpawn).not.toHaveBeenCalled();
  });

  it('uses fixed argv with shell disabled and cleans up container and temp workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-test-'));
    tempRoots.push(root);
    const workRoot = join(root, 'work');
    await mkdir(workRoot);
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const inputModes: number[] = [];
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      tempRoot: workRoot,
      spawn: fakeDocker(
        {
          OSType: 'linux',
          ServerVersion: '27.0',
          CgroupVersion: '2',
          SecurityOptions: ['name=rootless'],
        },
        calls,
        11,
        limits,
        [],
        inputModes,
      ),
    });
    const result = await sandbox.run({ image, firmware: new Uint8Array([1, 2, 3]), limits });
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.files['trace.json']!).toString()).toBe('{"ok":true}');
    const create = calls.find((call) => call.args[0] === 'create')!;
    expect(create.args.slice(-2)).toEqual(['/input/firmware.bin', '/output']);
    expect(
      create.args.slice(
        create.args.indexOf('--entrypoint'),
        create.args.indexOf('--entrypoint') + 2,
      ),
    ).toEqual(['--entrypoint', '/usr/local/bin/schemora-simulator']);
    expect(calls.every((call) => (call.options as { shell: boolean }).shell === false)).toBe(true);
    expect(inputModes).toEqual([0o444]);
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[1] === '--force')).toBe(true);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('enforces the aggregate output cap after copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-output-test-'));
    tempRoots.push(root);
    const workRoot = join(root, 'work');
    await mkdir(workRoot);
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const fake = fakeDocker(
      {
        OSType: 'linux',
        ServerVersion: '27.0',
        CgroupVersion: '2',
        SecurityOptions: ['name=rootless'],
      },
      calls,
      1025,
      { ...limits, outputBytes: 1024 },
    );
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      tempRoot: workRoot,
      spawn: fake,
    });
    await expect(
      sandbox.run({
        image,
        firmware: new Uint8Array([1]),
        limits: { ...limits, outputBytes: 1024 },
      }),
    ).rejects.toThrow('SANDBOX_OUTPUT_LIMIT');
    expect(calls.some((call) => call.args[0] === 'rm')).toBe(true);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('fails the run when forced container removal fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-cleanup-test-'));
    tempRoots.push(root);
    const workRoot = join(root, 'work');
    await mkdir(workRoot);
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      tempRoot: workRoot,
      spawn: fakeDocker(
        {
          OSType: 'linux',
          ServerVersion: '27.0',
          CgroupVersion: '2',
          SecurityOptions: ['name=rootless'],
        },
        calls,
        11,
        limits,
        ['rm'],
      ),
    });
    await expect(sandbox.run({ image, firmware: new Uint8Array([1]), limits })).rejects.toThrow(
      'SANDBOX_CLEANUP_FAILED',
    );
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('fails the run when workspace cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-workspace-cleanup-test-'));
    tempRoots.push(root);
    const workRoot = join(root, 'work');
    await mkdir(workRoot);
    const calls: Array<{ args: string[]; options: unknown }> = [];
    let leakedPath = '';
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      tempRoot: workRoot,
      spawn: fakeDocker(
        {
          OSType: 'linux',
          ServerVersion: '27.0',
          CgroupVersion: '2',
          SecurityOptions: ['name=rootless'],
        },
        calls,
      ),
      removeWorkspace: async (path) => {
        leakedPath = path;
        throw new Error('injected cleanup error');
      },
    });
    await expect(sandbox.run({ image, firmware: new Uint8Array([1]), limits })).rejects.toThrow(
      'SANDBOX_CLEANUP_FAILED',
    );
    expect(leakedPath).not.toBe('');
    await rm(leakedPath, { recursive: true, force: true });
  });

  it('caps output file count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-file-count-test-'));
    tempRoots.push(root);
    const workRoot = join(root, 'work');
    await mkdir(workRoot);
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const fake = fakeDocker(
      {
        OSType: 'linux',
        ServerVersion: '27.0',
        CgroupVersion: '2',
        SecurityOptions: ['name=rootless'],
      },
      calls,
      11,
      limits,
      [],
      undefined,
      257,
    );
    const sandbox = new DockerSandbox({
      platform: 'linux',
      uid: 1000,
      tempRoot: workRoot,
      spawn: fake,
    });
    await expect(sandbox.run({ image, firmware: new Uint8Array([1]), limits })).rejects.toThrow(
      'SANDBOX_OUTPUT_LIMIT',
    );
    expect(calls.some((call) => call.args[0] === 'rm')).toBe(true);
  });

  it.each(['__proto__/payload', 'constructor', 'prototype', `${'x/'.repeat(8)}file`])(
    'rejects unsafe or excessive output path %s',
    async (name) => {
      const root = await mkdtemp(join(tmpdir(), 'sandbox-unsafe-name-test-'));
      tempRoots.push(root);
      const workRoot = join(root, 'work');
      await mkdir(workRoot);
      const calls: Array<{ args: string[]; options: unknown }> = [];
      const sandbox = new DockerSandbox({
        platform: 'linux',
        uid: 1000,
        tempRoot: workRoot,
        spawn: fakeDocker(
          {
            OSType: 'linux',
            ServerVersion: '27.0',
            CgroupVersion: '2',
            SecurityOptions: ['name=rootless'],
          },
          calls,
          11,
          limits,
          [],
          undefined,
          1,
          null,
          [name],
        ),
      });
      await expect(sandbox.run({ image, firmware: new Uint8Array([1]), limits })).rejects.toThrow(
        'SANDBOX_OUTPUT_INVALID',
      );
    },
  );

  it.each([
    { hostConfig: { PidMode: 'host' } },
    { hostConfig: { IpcMode: 'host' } },
    { hostConfig: { Privileged: true } },
    { hostConfig: { Devices: [{ PathOnHost: '/dev/kvm' }] } },
    { hostConfig: { Tmpfs: { '/output': 'rw,size=2000000' } } },
    {
      mounts: [
        { Type: 'bind', Destination: '/input/firmware.bin', RW: false },
        { Type: 'tmpfs', Destination: '/output', RW: true },
        { Type: 'bind', Destination: '/unexpected', RW: true },
      ],
    },
  ])(
    'refuses a container with unexpected privilege, namespace, device, or mount controls',
    async (override) => {
      const root = await mkdtemp(join(tmpdir(), 'sandbox-controls-test-'));
      tempRoots.push(root);
      const workRoot = join(root, 'work');
      await mkdir(workRoot);
      const calls: Array<{ args: string[]; options: unknown }> = [];
      const sandbox = new DockerSandbox({
        platform: 'linux',
        uid: 1000,
        tempRoot: workRoot,
        spawn: fakeDocker(
          {
            OSType: 'linux',
            ServerVersion: '27.0',
            CgroupVersion: '2',
            SecurityOptions: ['name=rootless'],
          },
          calls,
          11,
          limits,
          [],
          undefined,
          1,
          null,
          undefined,
          override,
        ),
      });
      await expect(sandbox.run({ image, firmware: new Uint8Array([1]), limits })).rejects.toThrow(
        'SANDBOX_CONTROLS_UNAVAILABLE',
      );
      expect(calls.some((call) => call.args[0] === 'start')).toBe(false);
      expect(calls.some((call) => call.args[0] === 'rm')).toBe(true);
    },
  );
});
