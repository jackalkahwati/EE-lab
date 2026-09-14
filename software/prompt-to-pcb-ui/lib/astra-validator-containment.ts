/** Pure receipt validation; verifies recorded observations, never queries Docker. */
export const ASTRA_VALIDATOR_IMAGE = 'kicad/kicad@sha256:fdcfa0e8d41f640d16edfb28e027fe8862ab31af9e45dcacbc662cec5c916e4c'
// Explicit observed image.Id from the qualified 64dd... receipt. Equality to the
// manifest digest is this candidate's fact, not a general Docker identity rule.
export const ASTRA_VALIDATOR_IMAGE_ID = 'sha256:fdcfa0e8d41f640d16edfb28e027fe8862ab31af9e45dcacbc662cec5c916e4c'
export const ASTRA_VALIDATOR_JOB_ROOT = '/Volumes/T9 Backup/compose-ux-tmp-bQ4c59'
const ASSETS = '/Applications/KiCad/KiCad.app/Contents/SharedSupport'
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
function requireContainment(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`Validator containment evidence invalid: ${reason}`) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const empty = (x: unknown) => x === null || Array.isArray(x) && x.length === 0
function jobDirectory(jobId: unknown): string {
  requireContainment(typeof jobId === 'string' && /^astra-linux-job-[a-z0-9]{8,32}$/.test(jobId), 'fixed owned job identity')
  return `${ASTRA_VALIDATOR_JOB_ROOT}/${jobId}`
}

/** Browser-safe mirror of createArgs, parity-tested against the launch builder. */
export function expectedAstraValidatorCreateArgs(jobId: string, name: string): string[] {
  const dir = jobDirectory(jobId)
  const suffix = jobId.slice('astra-linux-job-'.length)
  requireContainment(new RegExp(`^astra-drc-${suffix}-[a-f0-9]{16}$`).test(name), 'container name must bind the owned job')
  return ['create', '--name', name, '--label', 'astra.operation=known-bad-drc-qualification',
    '--pull=never', '--platform', 'linux/amd64', '--network', 'none', '--read-only',
    '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--cpus', '2', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '128',
    '--ulimit', 'core=0:0', '--ulimit', 'fsize=33554432:33554432',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=134217728,mode=1777', '--shm-size', '16m', '--log-driver', 'none',
    '--mount', `type=bind,source=${dir}/input,target=/input,readonly`,
    '--mount', `type=bind,source=${dir}/assets,target=${ASSETS},readonly`,
    '--mount', `type=bind,source=${dir}/output,target=/output`,
    '--workdir', '/input', '--env', 'HOME=/tmp/home', '--env', 'XDG_CONFIG_HOME=/tmp/home/.config',
    '--env', 'XDG_CACHE_HOME=/tmp/home/.cache', '--env', `KICAD10_3DMODEL_DIR=${ASSETS}/3dmodels`,
    '--env', `KICAD10_FOOTPRINT_DIR=${ASSETS}/footprints`, '--entrypoint', '/bin/sh', ASTRA_VALIDATOR_IMAGE, '-c',
    'set -eu; mkdir -p /tmp/home/.config /tmp/home/.cache; id; uname -m; command -v kicad-cli; sha256sum "$(command -v kicad-cli)"; kicad-cli --version; exec kicad-cli pcb drc --format json --units mm --severity-all --output /output/drc.json /input/final-board.kicad_pcb']
}
export interface AstraValidatorContainment {
  version: 1; imageId: string; containerId: string; jobId: string; observedControls: true;
  requestedUser: '65532:65532'; observedUser: '65532:65532' | null; limitations: string[]
}
export function validateAstraValidatorContainment(receipt: unknown): AstraValidatorContainment {
  requireContainment(object(receipt) && receipt.schema === 'astra-linux-job-runtime/v1', 'runtime receipt required')
  const dir = jobDirectory(receipt.jobId)
  requireContainment(receipt.image === ASTRA_VALIDATOR_IMAGE && receipt.imageId === ASTRA_VALIDATOR_IMAGE_ID, 'pinned image identity')
  requireContainment(object(receipt.engine) && receipt.engine.Name === 'docker-desktop' && receipt.engine.OSType === 'linux' && receipt.engine.Architecture === 'aarch64' && typeof receipt.engine.ID === 'string' && receipt.engine.ID.length > 0, 'observed local engine')
  requireContainment(Array.isArray(receipt.createArgs) && receipt.createArgs.every((x: unknown) => typeof x === 'string') && receipt.createArgs[0] === 'create' && receipt.createArgs[1] === '--name', 'fixed create arguments required')
  requireContainment(same(receipt.createArgs, expectedAstraValidatorCreateArgs(receipt.jobId, receipt.createArgs[2])), 'create command or mount/environment policy differs')
  const container = receipt.container
  requireContainment(object(container) && typeof container.id === 'string' && /^[a-f0-9]{64}$/.test(container.id) && container.image === ASTRA_VALIDATOR_IMAGE_ID && object(container.hostConfig), 'observed container/image identity')
  const h = container.hostConfig
  requireContainment(h.NetworkMode === 'none' && h.ReadonlyRootfs === true && h.Privileged === false && same(h.CapDrop, ['ALL']) && empty(h.CapAdd) && same(h.SecurityOpt, ['no-new-privileges=true']), 'network/rootfs/privilege controls')
  requireContainment(h.NanoCpus === 2000000000 && h.Memory === 2147483648 && h.MemorySwap === 2147483648 && h.PidsLimit === 128 && h.ShmSize === 16777216 && h.OomKillDisable === false, 'resource ceilings')
  requireContainment(h.CpuPeriod === 0 && h.CpuQuota === 0 && h.CpuRealtimePeriod === 0 && h.CpuRealtimeRuntime === 0 && h.CpusetCpus === '' && h.CpusetMems === '', 'unqualified CPU override')
  requireContainment(object(h.Tmpfs) && same(h.Tmpfs, { '/tmp': 'rw,noexec,nosuid,nodev,size=134217728,mode=1777' }) && object(h.LogConfig) && h.LogConfig.Type === 'none' && object(h.LogConfig.Config) && Object.keys(h.LogConfig.Config).length === 0, 'bounded tmpfs and disabled logging')
  requireContainment(Array.isArray(h.Ulimits) && h.Ulimits.length === 2 && h.Ulimits.some((x: any) => object(x) && x.Name === 'core' && x.Hard === 0 && x.Soft === 0) && h.Ulimits.some((x: any) => object(x) && x.Name === 'fsize' && x.Hard === 33554432 && x.Soft === 33554432), 'file/core resource bounds')
  for (const key of ['Binds', 'VolumesFrom', 'Devices', 'DeviceCgroupRules', 'DeviceRequests', 'Links', 'ExtraHosts', 'GroupAdd']) requireContainment(Object.hasOwn(h, key) && empty(h[key]), `unexpected or missing ${key}`)
  requireContainment(object(h.PortBindings) && Object.keys(h.PortBindings).length === 0 && h.PublishAllPorts === false && h.PidMode === '' && h.IpcMode === 'private' && h.CgroupnsMode === 'private' && h.UTSMode === '' && h.UsernsMode === '', 'host namespace/port exposure')
  requireContainment(object(h.RestartPolicy) && h.RestartPolicy.Name === 'no' && h.RestartPolicy.MaximumRetryCount === 0 && h.AutoRemove === false, 'owned lifecycle policy')
  const expected = [{ source: `${dir}/input`, destination: '/input', writable: false }, { source: `${dir}/assets`, destination: ASSETS, writable: false }, { source: `${dir}/output`, destination: '/output', writable: true }]
  requireContainment(Array.isArray(container.mounts) && container.mounts.length === 3 && Array.isArray(h.Mounts) && h.Mounts.length === 3, 'exact three observed mounts required')
  for (const mount of expected) {
    const observed = container.mounts.filter((x: any) => object(x) && x.Destination === mount.destination)
    requireContainment(observed.length === 1 && observed[0].Type === 'bind' && observed[0].Source === mount.source && observed[0].RW === mount.writable && observed[0].Propagation === 'rprivate' && observed[0].Mode === '', 'observed mount containment')
    const requested = h.Mounts.filter((x: any) => object(x) && x.Target === mount.destination)
    requireContainment(requested.length === 1 && requested[0].Type === 'bind' && requested[0].Source === mount.source && (mount.writable ? requested[0].ReadOnly === undefined || requested[0].ReadOnly === false : requested[0].ReadOnly === true), 'host mount policy')
    requireContainment(Object.keys(requested[0]).every(key => ['Type', 'Source', 'Target', 'ReadOnly'].includes(key)), 'unqualified mount options')
  }
  // Older qualified receipts did not persist Config.User. The requested CLI UID
  // is verified above, but it cannot be promoted to an observed process UID.
  let observedUser: '65532:65532' | null = null
  if (Object.hasOwn(container, 'user')) {
    requireContainment(container.user === '65532:65532', 'observed container user must be nonroot fixed UID')
    observedUser = '65532:65532'
  }
  return { version: 1, imageId: ASTRA_VALIDATOR_IMAGE_ID, containerId: container.id, jobId: receipt.jobId,
    observedControls: true, requestedUser: '65532:65532', observedUser,
    limitations: observedUser === null ? ['Historical receipt records the requested UID but does not attest container Config.User or process UID.'] : ['Container Config.User is recorded; process UID is not independently attested by this validator.'] }
}
