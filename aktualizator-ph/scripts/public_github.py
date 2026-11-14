"""Atomic publication of a bounded, public-only snapshot on the dane branch.

Issue titles and bodies never become shell commands, paths or configuration.
Trusted control steps may use the short-lived GitHub token; builders do not.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
from zoneinfo import ZoneInfo
from public_support import (PublicError, GitHubApi, authenticated_environment, executable_digest, git, parse_time, record_diagnostic)
from public_admission import StateStore, acquire as acquire_lease, release as release_lease, request_time
from public_releases import ReleaseStore, release_record, pack_runtime_state, restore_state, file_digest

APP = Path(__file__).resolve().parents[1]
STATE = APP / '.public-state'
CONTROL = APP / '.public-control'
STAGE = 'START'
BRANCH = 'dane'
REF = 'refs/heads/' + BRANCH
PROFILE = 'public-nl-eu-corpus-v1'
INDEX_PROFILE = 'public-nl-ue-index-v2'
REQUEST_TITLE = '[Aktualizacja bazy]'
MAX_FILE = 95_000_000
MAX_RELEASE_ASSET = 2_147_483_648
MAX_TOTAL = 500_000_000
MAX_FILES = 10_000
COOLDOWN_SECONDS = 3600
CONFIG_FILES = ('aktualizator.json', 'zakres.json', 'zakres-ue.json')


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


def stage(value):
    global STAGE
    STAGE = value


def write_control(name, value):
    CONTROL.mkdir(parents=True, exist_ok=True)
    target = CONTROL / name
    target.write_text(json.dumps(value, indent=2) + '\n')


def read_control(name):
    target = CONTROL / name
    return json.loads(target.read_bytes()) if target.is_file() else None


def run_identity():
    run, attempt = os.environ.get('GITHUB_RUN_ID', ''), os.environ.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch('[1-9][0-9]*', run) or not re.fullmatch('[1-9][0-9]*', attempt):
        raise PublicError('RUN_IDENTITY_INVALID', 'ADMISSION')
    return run, int(attempt)


def state_store():
    repo = repository()
    return StateStore(APP, CONTROL / 'lease-git', repo, 'https://github.com/' + repo + '.git',
                      authenticated_environment(os.environ.get('GH_TOKEN', '')))


def acquire():
    stage('ADMISSION')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_bytes())
    if not trusted_event(os.environ.get('GITHUB_EVENT_NAME'), event, os.environ.get('GITHUB_REF')):
        raise PublicError('REQUEST_EVENT_INVALID', 'ADMISSION')
    run, attempt = run_identity()
    revision = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise PublicError('EXECUTABLE_REVISION_INVALID', 'ADMISSION')
    api = GitHubApi(repository(), os.environ.get('GH_TOKEN', ''))
    receipt = acquire_lease(state_store(), api, run, attempt, revision, request_time(api, run, attempt))
    write_control('admission.json', receipt)
    output(accepted=str(receipt['accepted']).lower())
    if not receipt['accepted']:
        code = receipt['reason']
        print('Aktualizacja już trwa lub trwała w chwili zgłoszenia. Prośba odrzucona; nie dodano jej do kolejki.')
        raise PublicError(code, 'ADMISSION')
    print('Updater lease acquired; this request is the only admitted operation.')


def release():
    stage('RELEASE')
    receipt = read_control('admission.json')
    if not receipt or not receipt.get('accepted'):
        print('No updater lease held by this request.')
        return
    result = read_control('result.json') or {'status': 'FAILED'}
    release_lease(state_store(), receipt, result['status'])
    print('Updater lease released; current idle status retained without a queue.')


def report():
    stage('REPORT')
    admission = read_control('admission.json') or {}
    publication = read_control('publication.json')
    candidate = read_control('publication-attempt.json')
    request = None
    if (STATE / 'request.json').is_file():
        request = json.loads((STATE / 'request.json').read_bytes())
    errors = []
    if (CONTROL / 'errors.jsonl').is_file():
        errors = [json.loads(row) for row in (CONTROL / 'errors.jsonl').read_text().splitlines() if row]
    if not admission.get('accepted') and admission.get('reason'):
        status = 'BUSY' if admission['reason'] == 'UPDATER_BUSY' else 'STALE'
    elif publication:
        status = 'PUBLISHED'
    elif candidate:
        status = 'UNKNOWN'
    elif request and not request['build'] and os.environ.get('PUBLIC_PREPARE_OUTCOME') == 'success':
        status = 'REUSED'
    else:
        status = 'FAILED'
    result = {'status': status, 'error': errors[-1] if errors else None,
              'dataRevision': publication['sha'] if publication else None}
    build_error = read_control('build-error.json')
    if build_error:
        result['error'] = {k: build_error[k] for k in ('code', 'stage')}
        print('::error title=Public corpus build::' + build_error['code'] + '; etap=' + build_error['stage'])
        if build_error.get('auditLine'):
            print('Independent audit location: verify_official_output.py:' + str(build_error['auditLine']))
    write_control('result.json', result)
    output(result=status)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    text = 'Wynik aktualizatora: **' + status + '**.\n'
    if result['error']:
        text += '\nKod: `' + result['error']['code'] + '`; etap: `' + result['error']['stage'] + '`.\n'
        if result['error'].get('location'):
            text += '\nMiejsce: `' + result['error']['location'] + '`.\n'
    if publication:
        text += '\nPublikacja potwierdzona: `' + publication['sha'] + '`.\n'
    if summary:
        with open(summary, 'a') as f:
            f.write(text)
    print(text)


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
    value = json.loads((directory / 'publication.json').read_bytes())
    if value.get('profile') == INDEX_PROFILE:
        required = {'README.md', 'publication.json', 'VERIFICATION.json'}
        if names != required or value.get('status') != 'PASS':
            raise ValueError('Incomplete public release index')
        if value.get('files') != [row for row in rows if row['name'] != 'publication.json']:
            raise ValueError('Public release index checksum inventory mismatch')
        for field, pattern in [('codeRevision', '[a-f0-9]{40}'), ('configurationSha256', '[a-f0-9]{64}'),
                               ('executionSha256', '[a-f0-9]{64}')]:
            if not re.fullmatch(pattern, value.get(field, '')):
                raise ValueError('Public release index identity missing')
        release = value.get('release', {})
        if (type(release.get('id')) is not int or release['id'] < 1
                or not re.fullmatch(r'data-[1-9][0-9]*-[1-9][0-9]*', release.get('tag', ''))
                or not isinstance(release.get('assets'), list)
                or not release['assets'] or not isinstance(value.get('counts'), dict)
                or value.get('sourceAudit') not in {'conditional', 'unconditional'}
                or json.loads((directory / 'VERIFICATION.json').read_bytes()).get('status') != 'PASS'):
            raise ValueError('Public release index pointer invalid')
        for entry in release['assets']:
            if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', entry.get('name', ''))
                    or '..' in entry['name'] or type(entry.get('size')) is not int or entry['size'] < 0
                    or not re.fullmatch('[a-f0-9]{64}', entry.get('sha256', ''))):
                raise ValueError('Public release index asset invalid')
        parse_time(value['publishedAt'])
        return value
    required = {'README.md', 'publication.json', 'VERIFICATION.json'} | {
        module + '/' + name for module in ('NL', 'UE') for name in ('INDEX.md', 'REPORT.md', 'manifest.json')}
    if not required <= names:
        raise ValueError('Incomplete paired public snapshot')
    expected = [row for row in rows if row['name'] != 'publication.json']
    if value.get('profile') != PROFILE or value.get('status') != 'PASS' or value.get('files') != expected:
        raise ValueError('Public snapshot checksum inventory mismatch')
    if not re.fullmatch('[a-f0-9]{40}', value.get('codeRevision', '')):
        raise ValueError('Snapshot producer revision is missing')
    if not re.fullmatch('[a-f0-9]{64}', value.get('configurationSha256', '')):
        raise ValueError('Snapshot configuration identity is missing')
    if value.get('executionSha256') is not None and not re.fullmatch('[a-f0-9]{64}', value['executionSha256']):
        raise PublicError('EXECUTION_IDENTITY_INVALID', 'VALIDATION')
    if value.get('sourceAudit', 'conditional') not in {'conditional', 'unconditional'}:
        raise PublicError('AUDIT_MODE_INVALID', 'VALIDATION')
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


def fresh(value, revision, config_digest, now, force=False, execution=None):
    same_execution = (value.get('executionSha256') == execution if value and value.get('executionSha256') and execution
                      else bool(value and value.get('codeRevision') == revision))
    if not value or force or not same_execution or value.get('configurationSha256') != config_digest:
        return False
    checked = parse_time(value['publishedAt'])
    age = (now - checked).total_seconds()
    return (0 <= age < COOLDOWN_SECONDS and value['rangeTo'] == now.astimezone(ZoneInfo('Europe/Warsaw')).date().isoformat())


def output(**values):
    destination = os.environ.get('GITHUB_OUTPUT')
    if destination:
        with open(destination, 'a', encoding='utf-8') as f:
            for name, value in values.items():
                f.write(name + '=' + str(value) + '\n')


def prepare():
    stage('PREPARE')
    admission = read_control('admission.json')
    if not admission or not admission.get('accepted'):
        raise PublicError('ADMISSION_REQUIRED', 'PREPARE')
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
    stage('RESTORE_PREVIOUS')
    sha, previous = restore_previous('https://github.com/' + repository() + '.git', STATE / 'prior')
    now = datetime.now(timezone.utc)
    stage('PLAN_BUILD')
    manual = os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
    full_audit = manual and os.environ.get('INPUT_FULL_SOURCE_AUDIT') == 'true'
    requested_force = manual and (os.environ.get('INPUT_FORCE') == 'true' or full_audit)
    execution = executable_digest(APP)
    rebuild = not fresh(previous, revision, configuration_digest(), now, requested_force, execution)
    state = dict(previousSha=sha, revision=revision, configSha256=configuration_digest(),
                 rangeTo=now.astimezone(ZoneInfo('Europe/Warsaw')).date().isoformat(), build=rebuild,
                 executionSha256=execution, sourceAudit='unconditional' if full_audit else 'conditional',
                 previousKnown=True, activeReleaseId=previous.get('release', {}).get('id') if previous else None)
    if previous:
        (STATE / 'previous-publication.json').write_text(json.dumps(previous))
    (STATE / 'request.json').write_text(json.dumps(state))
    if rebuild:
        if previous and previous.get('profile') != INDEX_PROFILE:
            for module, directory in [('NL', 'output'), ('UE', 'output-ue')]:
                target = APP / directory
                if target.exists():
                    raise ValueError('Build output must start empty')
                shutil.copytree(STATE / 'prior' / module, target)
        restore_runtime(previous if previous and previous.get('profile') == INDEX_PROFILE else None,full_audit)
    output(build=str(rebuild).lower(), range_to=state['rangeTo'], audit_mode=state['sourceAudit'])
    print('A new public build is required.' if rebuild else 'The current validated public corpus is still fresh.')


def release_store():
    return ReleaseStore(GitHubApi(repository(), os.environ.get('GH_TOKEN', '')))


def restore_runtime(previous=None, full_audit=False):
    """Use good outputs as comparison base, newest compatible checkpoints to resume."""
    if full_audit and not previous:
        return
    store = release_store()
    owner_run=os.environ.get('GITHUB_RUN_ID','');owner_attempt=os.environ.get('GITHUB_RUN_ATTEMPT','')
    if not full_audit and re.fullmatch(r'[1-9][0-9]*',owner_run) and re.fullmatch(r'[1-9][0-9]*',owner_attempt):
        store.recover_abandoned_drafts(owner_run,int(owner_attempt))
    active = previous['release'] if previous else None
    package = None
    if active:
        target = STATE / 'active-runtime'
        store.restore(active['id'], target, expected_assets=active['assets'], asset_names=['runtime-state.zip'])
        package = target / 'runtime-state.zip'
        restore_state(package, APP, selected_names={'output', 'output-ue'})
    if full_audit:
        return
    checkpoint = package
    for release in store.recent_attempts():
        candidate = release_record(release)
        metadata = candidate.get('metadata', {})
        if (metadata.get('configurationSha256') == configuration_digest()
                and any(entry['name'] == 'runtime-state.zip' for entry in candidate['assets'])):
            if active is None or release['id'] != active['id']:
                other = STATE / 'attempt-runtime'
                store.restore(release['id'], other, asset_names=['runtime-state.zip'])
                checkpoint = other / 'runtime-state.zip'
            break
    # The module builders independently check context, bytes and schemas before
    # accepting each checkpoint; a failed attempt is never trusted wholesale.
    if checkpoint is None:
        return
    restore_state(checkpoint, APP, selected_names=set(), optional_names={'.checkpoint', '.checkpoint-ue', '.source-cache'})
    if package is not None and not (APP / '.source-cache').exists():
        restore_state(package, APP, selected_names=set(), optional_names={'.source-cache'})


def validate_distribution(directory):
    value = json.loads((directory / 'distribution.json').read_bytes())
    if (value.get('profile') != 'public-distribution-v1' or value.get('status') != 'PASS'
            or not isinstance(value.get('files'), list) or not value.get('counts')):
        raise PublicError('DISTRIBUTION_INVALID', 'VALIDATE_DISTRIBUTION')
    expected = {'NL-results.zip', 'UE-results.zip', 'NL-sources.zip', 'UE-sources.zip'}
    files = value['files']
    if {entry.get('name') for entry in files} != expected or len(files) != len(expected):
        raise PublicError('DISTRIBUTION_INCOMPLETE', 'VALIDATE_DISTRIBUTION')
    for entry in files:
        path = directory / entry['name']
        if path.is_symlink() or not path.is_file():
            raise PublicError('DISTRIBUTION_FILE_UNSAFE', 'VALIDATE_DISTRIBUTION')
        size, digest = file_digest(path)
        if size != entry.get('bytes') or digest != entry.get('sha256'):
            raise PublicError('DISTRIBUTION_CHANGED', 'VALIDATE_DISTRIBUTION')
        if size >= MAX_RELEASE_ASSET:
            raise PublicError('RELEASE_ASSET_LIMIT', 'VALIDATE_DISTRIBUTION')
    return value


def recent_attempt_rows(store):
    return [{'runId': record['runId'], 'attempt': record['attempt'], 'status': record['status'],
             'releaseId': release['id'], 'url': release['html_url']}
            for release in store.recent_attempts()[:2] for record in [release_record(release)]]


def create_release_index(destination, request, release, distribution, audit, attempts=None):
    if destination.exists():
        raise PublicError('INDEX_TARGET_EXISTS', 'PUBLISH_INDEX')
    if audit.get('status') != 'PASS':
        raise PublicError('INDEPENDENT_AUDIT_REQUIRED', 'PUBLISH_INDEX')
    record = release_record(release)
    if not record or release.get('draft') or record['status'] != 'PUBLISHED':
        raise PublicError('RELEASE_NOT_CONFIRMED', 'PUBLISH_INDEX')
    destination.mkdir(parents=True)
    value = dict(profile=INDEX_PROFILE, status='PASS', publishedAt=datetime.now(timezone.utc).isoformat(),
                 rangeFrom=distribution['rangeFrom'], rangeTo=distribution['rangeTo'],
                 codeRevision=request['revision'], configurationSha256=request['configSha256'],
                 executionSha256=request['executionSha256'], sourceAudit=request['sourceAudit'],
                 counts=distribution['counts'], release={'id': release['id'], 'tag': release['tag_name'],
                     'url': release['html_url'], 'assets': record['assets']}, attempts=attempts or [])
    (destination / 'VERIFICATION.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    write_index_readme(destination, value)
    value['files'] = inventory(destination)
    (destination / 'publication.json').write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    validate_snapshot(destination)
    return value


def write_index_readme(destination, value):
    release = value['release']
    base = 'https://github.com/' + repository() + '/releases/download/' + release['tag'] + '/'
    text = ('# Aktualna publiczna baza prawa NL i UE\n\n'
            + f'Zakres: **{value["rangeFrom"]}–{value["rangeTo"]}**.\n\n'
            + f'NL: {value["counts"]["NL"]} aktów; UE: {value["counts"]["UE"]} pozycji.\n\n'
            + '[Otwórz wydanie z plikami](' + release['url'] + ')\n\n')
    for name, label in [('NL-results.zip', 'NL — teksty i raporty'), ('UE-results.zip', 'UE — teksty i raporty'),
                        ('NL-sources.zip', 'NL — wszystkie oryginalne źródła'), ('UE-sources.zip', 'UE — wszystkie oryginalne źródła')]:
        text += '- [' + label + '](' + base + name + ')\n'
    text += '\n[Manifest plików i SHA-256](publication.json) · [niezależny audyt](VERIFICATION.json).\n'
    if value.get('attempts'):
        text += '\n## Ostatnie uruchomienia\n\n'
        for attempt in value['attempts']:
            text += '- [' + attempt['runId'] + '/' + str(attempt['attempt']) + '](' + attempt['url'] + '): ' + attempt['status'] + '\n'
    text += '\nIndeks wskazuje ostatnią poprawną bazę. Nieudane uruchomienia nie zastępują poprawnych danych.\n'
    (destination / 'README.md').write_text(text)


def create_snapshot(app, destination, revision, config_digest, now, execution=None, source_audit='conditional'):
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
                 sourceAudit=source_audit, counts=counts, files=inventory(destination))
    if execution:
        value['executionSha256'] = execution
    (destination / 'publication.json').write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    validate_snapshot(destination)
    return value


def push_snapshot(snapshot, previous_sha, remote, env=None, record=None):
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
    if record:
        record(sha)
    stage('PUSH_DATA')
    try:
        git(snapshot, 'push', '--quiet', '--force-with-lease=' + REF + ':' + previous_sha,
            remote, 'HEAD:' + REF, env=env)
    except PublicError:
        current = git(snapshot, 'ls-remote', '--heads', remote, REF, env=env).stdout.decode().split()
        if current != [sha, REF]:
            raise PublicError('DATA_REF_CONFLICT' if current and current[0] != previous_sha else 'DATA_PUSH_FAILED', 'PUSH_DATA') from None
    stage('VERIFY_PUBLICATION')
    actual = git(snapshot, 'ls-remote', '--heads', remote, REF, env=env).stdout.decode().split()
    if actual != [sha, REF]:
        raise RuntimeError('Published snapshot ref could not be verified')
    return sha


def publish():
    stage('VERIFY_LEASE')
    receipt = read_control('admission.json')
    if not receipt or not receipt.get('accepted'):
        raise PublicError('ADMISSION_REQUIRED', 'PUBLISH')
    store = state_store()
    sha, state = store.read()
    if sha != receipt['sha'] or state['status'] != 'RUNNING':
        raise PublicError('LOCK_OWNERSHIP_CHANGED', 'PUBLISH')
    stage('VALIDATE_PUBLICATION')
    request = json.loads((STATE / 'request.json').read_bytes())
    if not request['build']:
        return
    if request['configSha256'] != configuration_digest() or request['executionSha256'] != executable_digest(APP):
        raise PublicError('BUILD_INPUT_CHANGED', 'PUBLISH')
    distribution_dir = STATE / 'distribution'
    distribution = validate_distribution(distribution_dir)
    if distribution['rangeTo'] != request['rangeTo']:
        raise PublicError('BUILD_RANGE_CHANGED', 'PUBLISH')
    audit = json.loads((STATE / 'independent-audit.json').read_bytes())
    if audit.get('status') != 'PASS':
        raise PublicError('INDEPENDENT_AUDIT_REQUIRED', 'PUBLISH')
    pack_runtime_state(APP, ['output', 'output-ue', '.checkpoint', '.checkpoint-ue', '.source-diagnostics'],
               distribution_dir / 'runtime-state.zip')
    run, attempt = run_identity()
    releases = release_store()
    metadata = {'configurationSha256': request['configSha256'], 'executionSha256': request['executionSha256'],
                'rangeFrom': distribution['rangeFrom'], 'rangeTo': distribution['rangeTo']}
    stage('STAGE_RELEASE')
    release_value = releases.publish(releases.stage(distribution_dir, run, attempt, request['revision'], metadata=metadata))
    write_control('release-attempt.json', {'id': release_value['id']})
    destination = STATE / 'snapshot'
    create_release_index(destination, request, release_value, distribution, audit, recent_attempt_rows(releases))
    sha = push_snapshot(destination, request['previousSha'], 'https://github.com/' + repository() + '.git',
                        authenticated_environment(os.environ.get('GH_TOKEN', '')),
                        record=lambda candidate: write_control('publication-attempt.json', {'sha': candidate}))
    write_control('publication.json', {'status': 'PUBLISHED', 'sha': sha, 'releaseId': release_value['id'], 'url': release_value['html_url']})
    print('Validated public corpus published. Revision: ' + sha)


def result_links(repo):
    base = 'https://github.com/' + repo
    return base + '/tree/dane', base + '/releases'


def retain():
    """Persist admitted attempts before garbage collection; lease remains held."""
    stage('PERSIST_ATTEMPT')
    admission = read_control('admission.json') or {}
    if not admission.get('accepted'):
        return
    lease_sha, lease = state_store().read()
    if lease_sha != admission['sha'] or lease.get('status') != 'RUNNING':
        raise PublicError('LOCK_OWNERSHIP_CHANGED', 'RETAIN')
    request = json.loads((STATE / 'request.json').read_bytes()) if (STATE / 'request.json').is_file() else None
    result = read_control('result.json') or {'status': 'FAILED'}
    publication = read_control('publication.json')
    active_id = publication.get('releaseId') if publication else request.get('activeReleaseId') if request else None
    releases = release_store()
    run, attempt = run_identity()
    def attempt_files(directory):
        directory.mkdir(parents=True,exist_ok=True)
        report_value={'profile':'public-attempt-v1','runId':run,'attempt':attempt,'status':result['status'],
                      'activeReleaseId':active_id,'error':result.get('error')}
        (directory/'attempt.json').write_text(json.dumps(report_value,indent=2)+'\n')
        if result['status']!='REUSED' and not (directory/'runtime-state.zip').exists():
            pack_runtime_state(APP,['output','output-ue','.checkpoint','.checkpoint-ue','.source-diagnostics'],directory/'runtime-state.zip')
        return directory
    existing = releases._get_tag('data-' + run + '-' + str(attempt))
    if not existing:
        attempt_dir = STATE / 'attempt-record'
        attempt_files(attempt_dir)
        metadata = {'activeReleaseId': active_id}
        if request:
            metadata.update(configurationSha256=request['configSha256'], executionSha256=request['executionSha256'])
        releases.record_attempt(attempt_dir, run, attempt, os.environ['GITHUB_SHA'],
                                'REUSED' if result['status'] == 'REUSED' else 'FAILED', metadata)
    elif not release_record(existing):
        raise PublicError('RELEASE_IDENTITY_CONFLICT', 'RETAIN')
    elif existing.get('draft'):
        # Reconcile only this admitted owner's draft. Unrelated interrupted
        # drafts are not garbage-collected while their status is uncertain.
        record=release_record(existing)
        directory=STATE/'distribution' if record['status']=='PUBLISHED' and (STATE/'distribution').is_dir() else STATE/'attempt-record'
        releases.publish(releases.reconcile_draft(existing,attempt_files(directory),
                         'REUSED' if result['status']=='REUSED' else 'FAILED'))
    stage('RETAIN_RELEASES')
    recovered_drafts=releases.recover_abandoned_drafts(run,attempt)
    if active_id is not None or request and request.get('previousKnown') is True:
        retained = releases.retain(active_id, keep_attempts=2)
    else:
        # Preflight failures may not have established the active-data pointer.
        # Preserve all data rather than guess which old success is disposable.
        retained = {'retained': [], 'deleted': [], 'status': 'ACTIVE_POINTER_UNKNOWN'}
    write_control('retention.json', retained)
    if recovered_drafts:write_control('draft-recovery.json',{'recovered':recovered_drafts})
    if active_id is not None:
        update_attempt_index(releases, publication)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as out:
            out.write('\nMateriały uruchomień zapisane; retencja: dwa ostatnie przebiegi i chroniona poprawna baza.\n')


def update_attempt_index(releases, publication):
    """Record failed/REUSED history without changing the active good release."""
    remote = 'https://github.com/' + repository() + '.git'
    previous_sha, previous = restore_previous(remote, STATE / 'retention-prior')
    if not previous or previous.get('profile') != INDEX_PROFILE:
        return
    expected_active = publication.get('releaseId') if publication else json.loads((STATE / 'request.json').read_bytes()).get('activeReleaseId')
    if previous['release']['id'] != expected_active:
        raise PublicError('ACTIVE_RELEASE_CHANGED', 'RETAIN')
    attempts = recent_attempt_rows(releases)
    if previous.get('attempts') == attempts:
        return
    target = STATE / 'retention-index'
    target.mkdir()
    previous['attempts'] = attempts
    shutil.copyfile(STATE / 'retention-prior/VERIFICATION.json', target / 'VERIFICATION.json')
    write_index_readme(target, previous)
    previous['files'] = inventory(target)
    (target / 'publication.json').write_text(json.dumps(previous, ensure_ascii=False, indent=2) + '\n')
    push_snapshot(target, previous_sha, remote, authenticated_environment(os.environ.get('GH_TOKEN', '')))


def find_comment(api, number, marker):
    for page in range(1, 11):
        comments = api.request('/issues/' + str(number) + '/comments?per_page=100&page=' + str(page))
        if not isinstance(comments, list):
            raise PublicError('COMMENT_RESPONSE_INVALID', 'NOTIFY')
        for comment in comments:
            if (comment.get('user', {}).get('login') == 'github-actions[bot]' and marker in comment.get('body', '')
                    and isinstance(comment.get('id'), int)):
                return comment
        if len(comments) < 100:
            return None
    raise PublicError('COMMENT_PAGINATION_LIMIT', 'NOTIFY')


def notify(api, number, body, marker):
    for attempt in range(3):
        try:
            previous = find_comment(api, number, marker)
            if previous:
                if previous['body'] != body:
                    api.request('/issues/comments/' + str(previous['id']), {'body': body}, 'PATCH')
                return
            api.request('/issues/' + str(number) + '/comments', {'body': body}, 'POST', attempts=1)
            return
        except PublicError:
            if attempt == 2:
                # A final lost POST response may still have created the comment.
                if find_comment(api, number, marker):
                    return
                raise
            api.wait(attempt + 1)


def finish_request():
    stage('NOTIFY')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_bytes())
    if os.environ.get('GITHUB_EVENT_NAME') != 'issues' or not trusted_event('issues', event, os.environ.get('GITHUB_REF')):
        return
    result = read_control('result.json') or {'status': 'FAILED'}
    status = result['status']
    repo = repository()
    run, attempt = run_identity()
    data, archive = result_links(repo)
    marker = '<!-- public-corpus-result:' + run + ':' + str(attempt) + ' -->'
    if status in {'PUBLISHED', 'REUSED'}:
        message = 'Gotowa, zweryfikowana baza jest dostępna.'
    elif status in {'BUSY', 'STALE'}:
        message = 'Prośba odrzucona: aktualizacja już trwa, trwała w chwili zgłoszenia albo GitHub dostarczył żądanie z opóźnieniem. Nie dodano go do kolejki i nie uruchomi się później.'
    elif status == 'UNKNOWN':
        message = 'Nie udało się potwierdzić końcowego stanu publikacji. Sprawdź wynik uruchomienia; dane mogły zostać zapisane.'
    else:
        message = 'Aktualizacja nie powiodła się. Wcześniej opublikowana poprawna baza, jeśli istniała, pozostaje dostępna.'
    body = marker + '\n' + message + '\n\nBaza: ' + data + '\n\nPobierz pliki z Releases: ' + archive
    admission = read_control('admission.json') or {}
    if admission.get('ownerRun'):
        body += '\n\nUruchomienie aktualizatora: https://github.com/' + repo + '/actions/runs/' + admission['ownerRun']
    body += '\n\nWynik żądania: https://github.com/' + repo + '/actions/runs/' + run
    if result.get('error'):
        body += '\n\nKod: `' + result['error']['code'] + '`; etap: `' + result['error']['stage'] + '`.'
    api = GitHubApi(repo, os.environ.get('GH_TOKEN', ''))
    notify(api, event['issue']['number'], body, marker)
    if status in {'PUBLISHED', 'REUSED', 'BUSY', 'STALE'}:
        api.request('/issues/' + str(event['issue']['number']),
                    {'state': 'closed', 'state_reason': 'completed' if status in {'PUBLISHED', 'REUSED'} else 'not_planned'}, 'PATCH')
    output(notification='success')
    print('Public request received its result. Status: ' + status)


def cleanup():
    # Required cache/checkpoints/outputs were persisted before this step and
    # also remain usable for local invocations. Only run-specific scratch goes.
    for name in ('.public-state', '.public-control'):
        target = APP / name
        if target.is_symlink():
            target.unlink()
        elif target.exists():
            shutil.rmtree(target)
    for name in ('public-build.log', '.cache-signatures.json'):
        (APP / name).unlink(missing_ok=True)
    print('Run scratch and logs removed; source cache, checkpoints and verified outputs preserved.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['acquire', 'prepare', 'publish', 'report', 'finish-request', 'retain', 'release', 'cleanup'])
    command = parser.parse_args().command
    stage(command.replace('-', '_').upper())
    commands = {'acquire': acquire, 'prepare': prepare, 'publish': publish, 'report': report,
                'finish-request': finish_request, 'retain': retain, 'release': release, 'cleanup': cleanup}
    try:
        commands[command]()
    except Exception as error:
        warning = command == 'finish-request'
        record_diagnostic(CONTROL, error, STAGE, warning=warning)
        if warning:
            output(notification='failed')
            print('Powiadomienie nie zostało wysłane. Wynik publikacji pozostaje bez zmian.')
            return 0
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
