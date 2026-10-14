import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lstat, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function tarArchive(
  entries: Array<{ name: string; data: Buffer; type?: number; size?: number; prefix?: string }>,
) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(
      (entry.size ?? entry.data.length).toString(8).padStart(11, '0') + '\0',
      124,
      12,
      'ascii',
    );
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = entry.type ?? 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

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
  outputTypes?: number[],
  malformedArchive = false,
  outputPrefixes?: string[],
  outputDeclaredSizes?: number[],
  truncateArchive = false,
  overflowArchive = false,
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
        const entries: Array<{
          name: string;
          data: Buffer;
          type?: number;
          size?: number;
          prefix?: string;
        }> = [{ name: '.', data: Buffer.alloc(0), type: 53 }];
        for (let index = 0; index < fileCount; index += 1) {
          const name =
            outputNames?.[index] ?? (fileCount === 1 ? 'trace.json' : `empty-${index}.bin`);
          const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
          if (parent && !entries.some((entry) => entry.name === `${parent}/`)) {
            entries.push({ name: `${parent}/`, data: Buffer.alloc(0), type: 53 });
          }
          entries.push({
            name,
            type: outputTypes?.[index],
            prefix: outputPrefixes?.[index],
            size: outputDeclaredSizes?.[index],
            data:
              outputSize === 11
                ? Buffer.from(fileCount === 1 ? '{"ok":true}' : '')
                : Buffer.alloc(outputSize, 120),
          });
        }
        const archive = tarArchive(entries);
        if (malformedArchive) archive[0] ^= 1;
        if (overflowArchive)
          child.stdout.write(Buffer.alloc(resourceLimits.outputBytes + 384 * 1024 + 1));
        else child.stdout.write(truncateArchive ? archive.subarray(0, -1025) : archive);
      }
      child.emit('close', failedCommands.includes(subcommand ?? '') ? 1 : 0);
    });
    return child;
  }) as never;
}

describe('DockerSandbox fail-closed preflight', () => {
  it('rejects a CPU limit that rounds to zero before contacting Docker', async () => {
    const sandbox = new DockerSandbox({ platform: 'linux', uid: 1000, spawn: noSpawn });
    await expect(
      sandbox.run({
        image,
        firmware: new Uint8Array([1]),
        limits: { ...limits, cpuCount: 0.0000000004 },
      }),
    ).rejects.toThrow('SANDBOX_LIMITS_INVALID');
    expect(noSpawn).not.toHaveBeenCalled();
  });

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

  it('attempts forced cleanup even when Docker create reports failure', async () => {
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
        ['create'],
      ),
    });
    await expect(sandbox.run({ image, firmware: new Uint8Array([1]), limits })).rejects.toThrow(
      'SANDBOX_CREATE_FAILED',
    );
    const generatedName = calls.find((call) => call.args[0] === 'create')?.args[
      calls.find((call) => call.args[0] === 'create')!.args.indexOf('--name') + 1
    ];
    expect(generatedName).toMatch(/^schemora-/);
    expect(calls.find((call) => call.args[0] === 'rm')?.args.at(-1)).toBe(generatedName);
  });

  it('rejects symlink tar entries and a corrupt tar header', async () => {
    for (const [outputTypes, malformedArchive] of [
      [[50], false],
      [undefined, true],
    ] as const) {
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
          null,
          undefined,
          undefined,
          outputTypes ? [...outputTypes] : undefined,
          malformedArchive,
        ),
      });
      await expect(sandbox.run({ image, firmware: new Uint8Array([1]), limits })).rejects.toThrow(
        'SANDBOX_OUTPUT_INVALID',
      );
    }
  });

  it('rejects oversized declarations, traversal prefixes, truncated tar data, and archive overflow', async () => {
    const smallLimits = { ...limits, outputBytes: 1024 };
    const cases: Array<{
      outputDeclaredSizes?: number[];
      outputPrefixes?: string[];
      truncateArchive?: boolean;
      overflowArchive?: boolean;
    }> = [
      { outputDeclaredSizes: [0o77777777777] },
      { outputPrefixes: ['../outside'] },
      { truncateArchive: true },
      { overflowArchive: true },
    ];
    for (const options of cases) {
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
          smallLimits,
          [],
          undefined,
          1,
          null,
          undefined,
          undefined,
          undefined,
          false,
          options.outputPrefixes,
          options.outputDeclaredSizes,
          options.truncateArchive,
          options.overflowArchive,
        ),
      });
      await expect(
        sandbox.run({ image, firmware: new Uint8Array([1]), limits: smallLimits }),
      ).rejects.toThrow();
    }
  });

  it('accepts the root directory entry and nested file paths from Docker tar output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-nested-tar-test-'));
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
        ['folder/trace.json'],
      ),
    });
    const result = await sandbox.run({ image, firmware: new Uint8Array([1]), limits });
    expect(Buffer.from(result.files['folder/trace.json']!).toString()).toBe('{"ok":true}');
    expect(calls.find((call) => call.args[0] === 'cp')?.args.at(-1)).toBe('-');
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
