import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAstraValidatorContainment, expectedAstraValidatorCreateArgs, ASTRA_VALIDATOR_IMAGE, ASTRA_VALIDATOR_IMAGE_ID, ASTRA_VALIDATOR_JOB_ROOT } from '../lib/astra-validator-containment.ts';
import { createArgs, IMAGE, JOB_ROOT } from '../scripts/astra-linux-drc.mjs';

// Explicit recorded-shape unit fixtures, not native runtime evidence. No Docker
// calls or private receipt reads are performed by this test suite.
const jobId = 'astra-linux-job-' + 'a'.repeat(32), dir = `${ASTRA_VALIDATOR_JOB_ROOT}/${jobId}`;
const name = 'astra-drc-' + 'a'.repeat(32) + '-' + 'b'.repeat(16);
const assets = '/Applications/KiCad/KiCad.app/Contents/SharedSupport';
function fixture() {
  const mounts = [['input', '/input', false], ['assets', assets, false], ['output', '/output', true]];
  return { schema: 'astra-linux-job-runtime/v1', jobId, image: ASTRA_VALIDATOR_IMAGE, imageId: ASTRA_VALIDATOR_IMAGE_ID,
    engine: { Name: 'docker-desktop', OSType: 'linux', Architecture: 'aarch64', ID: 'explicit-fixture-engine' },
    createArgs: expectedAstraValidatorCreateArgs(jobId, name), container: { id: 'c'.repeat(64), image: ASTRA_VALIDATOR_IMAGE_ID,
      mounts: mounts.map(([relative, destination, writable]) => ({ Type: 'bind', Source: `${dir}/${relative}`, Destination: destination, RW: writable, Propagation: 'rprivate', Mode: '' })),
      hostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges=true'], NanoCpus: 2000000000, Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 128, ShmSize: 16777216, OomKillDisable: false, CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: '', CpusetMems: '', Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=134217728,mode=1777' }, LogConfig: { Type: 'none', Config: {} }, Ulimits: [{ Name: 'core', Hard: 0, Soft: 0 }, { Name: 'fsize', Hard: 33554432, Soft: 33554432 }], Binds: null, VolumesFrom: null, Devices: [], DeviceCgroupRules: null, DeviceRequests: null, Links: null, ExtraHosts: null, GroupAdd: null, PortBindings: {}, PublishAllPorts: false, PidMode: '', IpcMode: 'private', CgroupnsMode: 'private', UTSMode: '', UsernsMode: '', RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
        Mounts: mounts.map(([relative, destination, writable]) => ({ Type: 'bind', Source: `${dir}/${relative}`, Target: destination, ...(writable ? {} : { ReadOnly: true }) })) } } };
}

test('fixed whole command matches authoritative source builder byte-for-byte', () => {
  assert.equal(ASTRA_VALIDATOR_IMAGE, IMAGE); assert.equal(ASTRA_VALIDATOR_JOB_ROOT, JOB_ROOT);
  assert.deepEqual(expectedAstraValidatorCreateArgs(jobId, name), createArgs(dir, name));
  assert.throws(() => expectedAstraValidatorCreateArgs(jobId, 'astra-drc-otherjob-' + 'b'.repeat(16)));
});

test('historical observed controls validate without manufacturing an observed user attestation', () => {
  const result = validateAstraValidatorContainment(fixture());
  assert.equal(result.observedControls, true); assert.equal(result.observedUser, null); assert.equal(result.requestedUser, '65532:65532');
  assert.match(result.limitations[0], /does not attest/);
  const receipt = fixture(); receipt.container.user = '65532:65532';
  assert.equal(validateAstraValidatorContainment(receipt).observedUser, '65532:65532');
  receipt.container.user = '0:0'; assert.throws(() => validateAstraValidatorContainment(receipt));
});

test('missing receipt/image/actual host fields fail even with intact requested arguments', () => {
  for (const value of [null, {}, { image: ASTRA_VALIDATOR_IMAGE }]) assert.throws(() => validateAstraValidatorContainment(value));
  for (const path of [['image'], ['imageId'], ['container', 'image'], ['container', 'hostConfig', 'NetworkMode'], ['container', 'hostConfig', 'Devices'], ['container', 'mounts']]) {
    const value = fixture(); let parent = value; for (const key of path.slice(0, -1)) parent = parent[key]; delete parent[path.at(-1)];
    assert.throws(() => validateAstraValidatorContainment(value));
  }
});

test('wrong engine/image IDs and modified command, UID, network or severity options are rejected', () => {
  for (const mutate of [r => { r.imageId = 'sha256:' + '0'.repeat(64); }, r => { r.container.image = 'sha256:' + '0'.repeat(64); }, r => { r.engine.Name = 'other'; }, r => { r.createArgs[r.createArgs.indexOf('--user') + 1] = '0'; }, r => { r.createArgs.push('--privileged'); }, r => { r.createArgs[r.createArgs.indexOf('--network') + 1] = 'host'; }, r => { r.createArgs[r.createArgs.length - 1] += '; id'; }]) {
    const r = fixture(); mutate(r); assert.throws(() => validateAstraValidatorContainment(r));
  }
});

test('actual network/rootfs/privilege, resource and namespace weakening is rejected', () => {
  for (const [key, value] of Object.entries({ NetworkMode: 'bridge', ReadonlyRootfs: false, Privileged: true, CapDrop: [], CapAdd: ['SYS_ADMIN'], SecurityOpt: [], NanoCpus: 0, Memory: 0, MemorySwap: -1, PidsLimit: -1, ShmSize: 1000000000, OomKillDisable: true, CpuQuota: 100, IpcMode: 'host', PidMode: 'host', CgroupnsMode: 'host', PublishAllPorts: true, Ulimits: [], Tmpfs: {}, Binds: ['/private:/private'], Devices: [{ PathOnHost: '/dev/disk0' }], DeviceRequests: [{}], VolumesFrom: ['other-container'], GroupAdd: ['0'] })) {
    const r = fixture(); r.container.hostConfig[key] = value; assert.throws(() => validateAstraValidatorContainment(r), key);
  }
});

test('mount count/source/destination/read-only/propagation are exact and no socket mount can hide', () => {
  for (const mutate of [r => { r.container.mounts[0].RW = true; }, r => { r.container.mounts[2].RW = false; }, r => { r.container.mounts[0].Source = '/Users/private'; }, r => { r.container.mounts[1].Destination = '/var/run/docker.sock'; }, r => { r.container.mounts.push({ Type: 'bind', Source: '/socket', Destination: '/socket', RW: true }); }, r => { r.container.mounts[0].Propagation = 'rshared'; }, r => { r.container.hostConfig.Mounts[0].ReadOnly = false; }, r => { r.container.hostConfig.Mounts[0].BindOptions = { Propagation: 'rshared' }; }]) {
    const r = fixture(); mutate(r); assert.throws(() => validateAstraValidatorContainment(r));
  }
  const reordered = fixture(); reordered.container.mounts.reverse(); reordered.container.hostConfig.Mounts.reverse();
  assert.equal(validateAstraValidatorContainment(reordered).observedControls, true);
});
