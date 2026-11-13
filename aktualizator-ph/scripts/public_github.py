"""Atomic publication of a bounded, public-only snapshot on the dane branch.

Issue titles and bodies never become shell commands, paths or configuration.
Only the publish step receives the short-lived GitHub token; builders do not.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
from zoneinfo import ZoneInfo

APP = Path(__file__).resolve().parents[1]
STATE = APP / '.public-state'
BRANCH = 'dane'
REF = 'refs/heads/' + BRANCH
PROFILE = 'public-nl-eu-corpus-v1'
REQUEST_TITLE = '[Aktualizacja bazy]'
MAX_FILE = 95_000_000
MAX_TOTAL = 500_000_000
MAX_FILES = 10_000
COOLDOWN_SECONDS = 3600
CONFIG_FILES = ('aktualizator.json', 'zakres.json', 'zakres-ue.json')


def git(directory, *args, env=None, acceptable=(0,)):
    process = subprocess.run(['git', '-C', str(directory), *args], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    if process.returncode not in acceptable:
        raise RuntimeError('Git operation failed; no source or credential diagnostics are echoed')
    return process


def repository():
    value = os.environ.get('GITHUB_REPOSITORY', '')
    if not re.fullmatch(r'[-A-Za-z0-9_.]+/[-A-Za-z0-9_.]+', value):
        raise ValueError('Invalid repository identity')
    return value


def trusted_event(event_name, event, ref):
    if ref != 'refs/heads/main':
        return False
    if event_name == 'workflow_dispatch':
        return True
    issue = event.get('issue', {})
    return (event_name == 'issues' and event.get('action') == 'opened'
            and issue.get('title') == REQUEST_TITLE and not issue.get('pull_request')
            and isinstance(issue.get('number'), int) and issue['number'] > 0)


def configuration_digest():
    value = hashlib.sha256()
    for name in CONFIG_FILES:
        value.update(name.encode() + b'\0' + (APP / 'config' / name).read_bytes())
    return value.hexdigest()


def allowed_name(name):
    if name in {'README.md', 'publication.json', 'VERIFICATION.json'}:
        return True
    match = re.fullmatch(r'(NL|UE)/([A-Za-z0-9_.-]+)', name)
    return bool(match and match[2] not in {'.', '..'})


def inventory(directory):
    rows = []
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('Snapshot cannot contain symlinks')
        if path.is_dir():
            if path.relative_to(directory).as_posix() not in {'NL', 'UE'}:
                raise ValueError('Unexpected snapshot directory')
            continue
        name = path.relative_to(directory).as_posix()
        if not path.is_file() or not allowed_name(name) or path.stat().st_size > MAX_FILE:
            raise ValueError('Unexpected or oversized public file')
        blob = path.read_bytes()
        rows.append(dict(name=name, bytes=len(blob), sha256=hashlib.sha256(blob).hexdigest()))
    if len(rows) > MAX_FILES or sum(row['bytes'] for row in rows) > MAX_TOTAL:
        raise ValueError('Public snapshot storage limit exceeded')
    return rows


def validate_snapshot(directory):
    rows = inventory(directory)
    names = {row['name'] for row in rows}
    required = {'README.md', 'publication.json', 'VERIFICATION.json'} | {
        module + '/' + name for module in ('NL', 'UE') for name in ('INDEX.md', 'REPORT.md', 'manifest.json')}
    if not required <= names:
        raise ValueError('Incomplete paired public snapshot')
    value = json.loads((directory / 'publication.json').read_bytes())
    expected = [row for row in rows if row['name'] != 'publication.json']
    if value.get('profile') != PROFILE or value.get('status') != 'PASS' or value.get('files') != expected:
        raise ValueError('Public snapshot checksum inventory mismatch')
    if not re.fullmatch('[a-f0-9]{40}', value.get('codeRevision', '')):
        raise ValueError('Snapshot producer revision is missing')
    if not re.fullmatch('[a-f0-9]{64}', value.get('configurationSha256', '')):
        raise ValueError('Snapshot configuration identity is missing')
    if not isinstance(value.get('counts'), dict):
        raise ValueError('Snapshot corpus counts are missing')
    for module in ('NL', 'UE'):
        manifest = json.loads((directory / module / 'manifest.json').read_bytes())
        jurisdiction = 'EU' if module == 'UE' else 'NL'
        if (manifest.get('jurisdiction') != jurisdiction or not manifest.get('acts')
                or manifest.get('rangeFrom') != value.get('rangeFrom')
                or manifest.get('rangeTo') != value.get('rangeTo')
                or len(manifest['acts']) != value['counts'].get(module)):
            raise ValueError('Snapshot module identity/range/count mismatch')
    return value


def restore_previous(remote, target):
    result = git(APP, 'ls-remote', '--exit-code', '--heads', remote, REF, acceptable=(0, 2))
    if result.returncode == 2:
        return '', None
    rows = result.stdout.decode().splitlines()
    if len(rows) != 1 or not re.fullmatch(r'[a-f0-9]{40}\s+' + re.escape(REF), rows[0]):
        raise ValueError('Ambiguous data branch')
    expected = rows[0].split()[0]
    target.mkdir(parents=True)
    git(target, 'init', '--quiet')
    git(target, 'config', 'core.autocrlf', 'false')
    git(target, 'fetch', '--quiet', '--no-tags', '--depth=1', remote, REF)
    actual = git(target, 'rev-parse', 'FETCH_HEAD').stdout.decode().strip()
    if actual != expected:
        raise ValueError('Data branch changed while reading')
    # Validate the entire fetched tree before materializing any path.
    tree = git(target, 'ls-tree', '-r', '-z', 'FETCH_HEAD').stdout.split(b'\0')
    if len(tree) > MAX_FILES + 1:
        raise ValueError('Public tree entry limit exceeded')
    for row in filter(None, tree):
        header, name = row.split(b'\t', 1)
        if not header.startswith(b'100644 blob ') or not allowed_name(name.decode()):
            raise ValueError('The data branch contains unmanaged paths')
    commit = git(target, 'cat-file', '-p', 'FETCH_HEAD').stdout.split(b'\n\n', 1)[0]
    if any(row.startswith(b'parent ') for row in commit.splitlines()):
        raise ValueError('Data branch must contain a single independent snapshot')
    git(target, 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
    # The local Git database is technical state, not part of the public payload.
    database = target / '.git'
    parked = target.parent / 'prior-git'
    database.rename(parked)
    try:
        value = validate_snapshot(target)
    finally:
        parked.rename(database)
    return actual, value


def fresh(value, revision, config_digest, now, force=False):
    if not value or force or value.get('codeRevision') != revision or value.get('configurationSha256') != config_digest:
        return False
    checked = datetime.fromisoformat(value['publishedAt'])
    age = (now - checked).total_seconds()
    return (0 <= age < COOLDOWN_SECONDS and value['rangeTo'] == now.astimezone(ZoneInfo('Europe/Warsaw')).date().isoformat())


def output(**values):
    destination = os.environ.get('GITHUB_OUTPUT')
    if destination:
        with open(destination, 'a', encoding='utf-8') as f:
            for name, value in values.items():
                f.write(name + '=' + str(value) + '\n')


def prepare():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_bytes())
    if not trusted_event(os.environ.get('GITHUB_EVENT_NAME'), event, os.environ.get('GITHUB_REF')):
        raise ValueError('Unsupported public refresh request')
    if STATE.exists():
        raise ValueError('Public work directory must start empty')
    STATE.mkdir()
    revision = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('Exact build revision required')
    if git(APP, 'rev-parse', 'HEAD').stdout.decode().strip() != revision:
        raise ValueError('Checked-out code differs from the event revision')
    sha, previous = restore_previous('https://github.com/' + repository() + '.git', STATE / 'prior')
    now = datetime.now(timezone.utc)
    requested_force = os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('INPUT_FORCE') == 'true'
    rebuild = not fresh(previous, revision, configuration_digest(), now, requested_force)
    state = dict(previousSha=sha, revision=revision, configSha256=configuration_digest(),
                 rangeTo=now.astimezone(ZoneInfo('Europe/Warsaw')).date().isoformat(), build=rebuild)
    (STATE / 'request.json').write_text(json.dumps(state))
    if previous and rebuild:
        for module, directory in [('NL', 'output'), ('UE', 'output-ue')]:
            target = APP / directory
            if target.exists():
                raise ValueError('Build output must start empty')
            shutil.copytree(STATE / 'prior' / module, target)
    output(build=str(rebuild).lower(), range_to=state['rangeTo'])
    print('A new public build is required.' if rebuild else 'The current validated public corpus is still fresh.')


def create_snapshot(app, destination, revision, config_digest, now):
    if destination.exists():
        raise ValueError('New snapshot directory required')
    destination.mkdir(parents=True)
    manifests = {}
    for module, name in [('NL', 'output'), ('UE', 'output-ue')]:
        source = app / name
        if any(not p.is_file() or p.is_symlink() for p in source.iterdir()):
            raise ValueError('Public outputs must contain regular files only')
        shutil.copytree(source, destination / module)
        manifests[module] = json.loads((source / 'manifest.json').read_bytes())
    expected = json.loads((app / '.public-state/validated-files.json').read_bytes())
    actual = inventory(destination)
    if sorted(expected, key=lambda row: row['name']) != actual:
        raise ValueError('Public payload changed after validation')
    ranges = {(m['rangeFrom'], m['rangeTo']) for m in manifests.values()}
    if len(ranges) != 1:
        raise ValueError('Both public modules must have the same date range')
    range_from, range_to = next(iter(ranges))
    counts = {module: len(value['acts']) for module, value in manifests.items()}
    audit = json.loads((app / '.public-state/independent-audit.json').read_bytes())
    if audit.get('status') != 'PASS':
        raise ValueError('Independent source audit must pass before publication')
    (destination / 'VERIFICATION.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    (destination / 'README.md').write_text(
        '# Aktualna publiczna baza prawa NL i UE\n\n'
        + f'Zakres: **{range_from}–{range_to}**. Zbudowano {now.isoformat()}.\n\n'
        + f'* [NL — {counts["NL"]} aktów](NL/INDEX.md) · [raport](NL/REPORT.md)\n'
        + f'* [UE — {counts["UE"]} pozycji](UE/INDEX.md) · [raport](UE/REPORT.md)\n\n'
        + 'Oryginalne źródła, teksty i raporty pochodzą z tej samej sprawdzonej publikacji. '
        + 'Ostrzeżenia o dostępności reprezentacji i metadanych są zachowane w raportach.\n\n'
        + '[Kontrola plików i SHA-256](publication.json) · [niezależny audyt](VERIFICATION.json).\n\n'
        + 'Ta gałąź zawiera tylko bieżący zestaw. Starsze snapshoty techniczne są zastępowane. '
        + 'Historyczne wersje przepisów potrzebne do wskazanego zakresu pozostają częścią korpusu.\n\n'
        + 'Materiały urzędowe nie stanowią porady prawnej. Warunki ponownego użycia źródeł '
        + 'opisano w THIRD_PARTY.md na gałęzi z kodem.\n', encoding='utf-8')
    value = dict(profile=PROFILE, status='PASS', publishedAt=now.isoformat(), rangeFrom=range_from,
                 rangeTo=range_to, codeRevision=revision, configurationSha256=config_digest,
                 counts=counts, files=inventory(destination))
    (destination / 'publication.json').write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    validate_snapshot(destination)
    return value


def authenticated_environment(token):
    if not token or '\n' in token or '\r' in token:
        raise ValueError('A short-lived GitHub publication token is required')
    env = dict(os.environ)
    env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
               GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode(),
               GIT_TERMINAL_PROMPT='0')
    return env


def push_snapshot(snapshot, previous_sha, remote, env=None):
    validate_snapshot(snapshot)
    if previous_sha and not re.fullmatch('[a-f0-9]{40}', previous_sha):
        raise ValueError('Invalid expected previous snapshot')
    git(snapshot, 'init', '--quiet', '--initial-branch=' + BRANCH)
    git(snapshot, 'config', 'core.autocrlf', 'false')
    git(snapshot, 'config', 'user.name', 'github-actions[bot]')
    git(snapshot, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    git(snapshot, 'add', '--all')
    git(snapshot, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Publish validated current NL/EU corpus')
    sha = git(snapshot, 'rev-parse', 'HEAD').stdout.decode().strip()
    # Exact lease: never overwrite a concurrent publisher or any code branch.
    git(snapshot, 'push', '--quiet', '--force-with-lease=' + REF + ':' + previous_sha,
        remote, 'HEAD:' + REF, env=env)
    actual = git(snapshot, 'ls-remote', '--heads', remote, REF, env=env).stdout.decode().split()
    if actual != [sha, REF]:
        raise RuntimeError('Published snapshot ref could not be verified')
    return sha


def publish():
    request = json.loads((STATE / 'request.json').read_bytes())
    if not request['build']:
        return
    if request['configSha256'] != configuration_digest():
        raise ValueError('Configuration changed during the build')
    destination = STATE / 'snapshot'
    value = create_snapshot(APP, destination, request['revision'], request['configSha256'], datetime.now(timezone.utc))
    if value['rangeTo'] != request['rangeTo']:
        raise ValueError('Published end date differs from the frozen build request')
    sha = push_snapshot(destination, request['previousSha'], 'https://github.com/' + repository() + '.git',
                        authenticated_environment(os.environ.get('GH_TOKEN', '')))
    print('Validated public corpus published; previous snapshot branch replaced atomically. Revision: ' + sha)


def finish_request():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_bytes())
    if os.environ.get('GITHUB_EVENT_NAME') != 'issues':
        return
    if not trusted_event('issues', event, os.environ.get('GITHUB_REF')):
        return
    succeeded = os.environ.get('PUBLIC_JOB_STATUS') == 'success'
    repo = repository()
    run = os.environ.get('GITHUB_RUN_ID', '')
    if not re.fullmatch('[1-9][0-9]*', run):
        raise ValueError('Invalid workflow run identity')
    base = 'https://github.com/' + repo
    body = ('Gotowa baza jest dostępna: ' + base + '/tree/dane\n\nPobierz ZIP: ' + base + '/archive/refs/heads/dane.zip'
            if succeeded else 'Aktualizacja nie powiodła się. Ostatnia poprawna baza pozostaje dostępna: ' + base + '/tree/dane')
    body += '\n\nWynik uruchomienia: ' + base + '/actions/runs/' + run
    def api(suffix, payload, method='POST'):
        request = urllib.request.Request('https://api.github.com/repos/' + repo + '/issues/' + str(event['issue']['number']) + suffix,
            data=json.dumps(payload).encode(), method=method, headers={'Accept':'application/vnd.github+json',
            'Authorization':'Bearer ' + os.environ['GH_TOKEN'], 'X-GitHub-Api-Version':'2022-11-28'})
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read(1_000_000)
    api('/comments', {'body': body})
    if succeeded:
        api('', {'state': 'closed', 'state_reason': 'completed'}, 'PATCH')
    print('Public refresh request received its result links.')


def cleanup():
    for name in ('.public-state', '.checkpoint', '.checkpoint-ue', '.source-cache', '.source-diagnostics', 'output', 'output-ue'):
        target = APP / name
        if target.is_symlink():
            target.unlink()
        elif target.exists():
            shutil.rmtree(target)
    for name in ('public-build.log',):
        (APP / name).unlink(missing_ok=True)
    print('Public build temporary outputs, checkpoints, sources, logs and Git work directories removed.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'publish', 'finish-request', 'cleanup'])
    value = parser.parse_args().command
    {'prepare': prepare, 'publish': publish, 'finish-request': finish_request, 'cleanup': cleanup}[value]()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Public corpus operation failed. Existing published data was not deliberately deleted.', file=sys.stderr)
        sys.exit(1)
