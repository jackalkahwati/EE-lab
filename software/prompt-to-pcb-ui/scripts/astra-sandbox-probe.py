"""Fixed, bounded containment attestation. No user code, imports from jobs, or network sends."""
import errno
import json
import os
import socket
import sys


def denied(action):
    try:
        action()
    except OSError as exc:
        return exc.errno in (errno.EPERM, errno.EACCES)
    return False


def forbidden_read():
    # Public OS fixture, not user/private data. A missing file does not pass.
    with open('/private/etc/hosts', 'rb') as source:
        source.read(1)


def forbidden_write(root):
    path = os.path.join(os.path.dirname(root), '.astra-forbidden-write-' + str(os.getpid()))
    with open(path, 'xb') as target:
        target.write(b'containment failed')
    os.unlink(path)


def network(loopback):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        if loopback:
            sock.bind(('127.0.0.1', 0))
        else:
            # UDP connect emits no packet; TEST-NET-1 is reserved, no DNS lookup.
            sock.connect(('192.0.2.1', 9))
    finally:
        sock.close()


def main():
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] not in ('pcbnew', 'kiface-load', 'dyld-env-presence', 'drc-dyld-trace')):
        raise RuntimeError('fixed probe requires its owned job root')
    root = sys.argv[1]
    if not os.path.isabs(root) or os.path.realpath(root) != root or os.getcwd() != root:
        raise RuntimeError('invalid owned root')
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[2] == 'drc-dyld-trace':
        import hashlib
        import stat
        cli = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
        expected = '04d9e61cad2e80cf7ad6c3da06417a6d7e8e2cdd23efc99957a1184e604d6657'
        with open(cli, 'rb') as source:
            actual = hashlib.sha256(source.read()).hexdigest()
        if os.path.realpath(cli) != cli or actual != expected:
            raise RuntimeError('fixed KiCad CLI provenance mismatch')
        for path in (root, os.path.join(root, 'home'), os.path.join(root, 'tmp')):
            info = os.lstat(path)
            if os.path.realpath(path) != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise RuntimeError('invalid private diagnostic directory')
        trace = os.path.join(root, 'dyld.log')
        board = os.path.join(root, 'final-board.kicad_pcb')
        for path in (trace, board):
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or os.path.realpath(path) != path:
                raise RuntimeError('invalid owned diagnostic file')
        if os.stat(trace).st_size != 0 or os.stat(trace).st_mode & 0o077:
            raise RuntimeError('diagnostic trace was not exclusively reserved')
        output = os.path.join(root, 'drc.json')
        if os.path.lexists(output):
            raise RuntimeError('diagnostic output already exists')
        app = '/Applications/KiCad/KiCad.app/Contents'
        # Reconstruct the reviewed allowlist. Nothing is copied from os.environ.
        environment = {'HOME': os.path.join(root, 'home'), 'TMPDIR': os.path.join(root, 'tmp') + '/',
                       'TMP': os.path.join(root, 'tmp'), 'TEMP': os.path.join(root, 'tmp'),
                       'PATH': app + '/MacOS', 'LANG': 'C', 'LC_ALL': 'C', 'NODE_ENV': 'development',
                       'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                       'KICAD10_3DMODEL_DIR': app + '/SharedSupport/3dmodels',
                       'KICAD10_FOOTPRINT_DIR': app + '/SharedSupport/footprints',
                       'DYLD_PRINT_APIS': '1', 'DYLD_PRINT_TO_FILE': trace}
        # execve preserves the existing sandbox and process group; failure propagates nonzero.
        os.execve(cli, [cli, 'pcb', 'drc', '--format', 'json', '--output', output, board], environment)
        raise RuntimeError('execve unexpectedly returned')
    if len(sys.argv) == 3 and sys.argv[2] == 'dyld-env-presence':
        print(json.dumps({'schema': 'astra-dyld-env-presence/v1',
                          'printApisPresent': os.environ.get('DYLD_PRINT_APIS') == '1',
                          'tracePathPresent': os.environ.get('DYLD_PRINT_TO_FILE') == os.path.join(root, 'dyld.log')}))
        return 0
    if len(sys.argv) == 3 and sys.argv[2] == 'kiface-load':
        import ctypes
        import hashlib
        plugin = '/Applications/KiCad/KiCad.app/Contents/PlugIns/_pcbnew.kiface'
        expected = '55f9c413c89676c126b64125a4a71d6a58a5309e0bdd3155f4d0375c59904245'
        digest = hashlib.sha256()
        with open(plugin, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        if os.path.realpath(plugin) != plugin or digest.hexdigest() != expected:
            raise RuntimeError('fixed PCB plugin provenance mismatch')
        report = {'schema': 'astra-kiface-load-probe/v1', 'context': 'bundled-python-not-kicad-cli',
                  'loaded': False, 'pluginSha256': expected}
        try:
            ctypes.CDLL(plugin, mode=os.RTLD_NOW | os.RTLD_GLOBAL)
            report['loaded'] = True
        except OSError as exc:
            # Raw loader paths remain in private job diagnostics, never in an API error.
            report['loaderError'] = str(exc)[:2048]
        with open(os.path.join(root, 'kiface-load-diagnostic.json'), 'x') as target:
            json.dump(report, target)
        print(json.dumps({key: value for key, value in report.items() if key != 'loaderError'}))
        return 0
    if len(sys.argv) == 3:
        import pcbnew
        print(json.dumps({'schema': 'astra-pcbnew-probe/v1', 'version': pcbnew.Version(),
                          'footprintLoad': callable(pcbnew.FootprintLoad),
                          'exportSpecctraDSN': callable(pcbnew.ExportSpecctraDSN),
                          'importSpecctraSES': callable(pcbnew.ImportSpecctraSES)}))
        return 0
    owned = os.path.join(root, 'tmp', 'containment-owned.txt')
    with open(owned, 'x') as target:
        target.write('owned')
    with open(owned) as source:
        own_ok = source.read() == 'owned'
    os.unlink(owned)
    results = [own_ok, denied(forbidden_read), denied(lambda: forbidden_write(root)),
               denied(lambda: network(True)), denied(lambda: network(False))]
    reader, writer = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(reader)
        checks = [denied(forbidden_read), denied(lambda: forbidden_write(root)), denied(lambda: network(True))]
        os.write(writer, json.dumps(checks).encode('ascii'))
        os.close(writer)
        os._exit(0 if all(checks) else 1)
    os.close(writer)
    child_results = json.loads(os.read(reader, 256).decode('ascii'))
    os.close(reader)
    _, status = os.waitpid(child, 0)
    results.extend(child_results)
    passed = len(results) == 8 and all(value is True for value in results) and status == 0
    print(json.dumps({'schema': 'astra-sandbox-probe/v1', 'passed': passed, 'checks': len(results), 'results': results}))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
