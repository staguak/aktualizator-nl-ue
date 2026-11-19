"""Archive GitHub workflow/Git and SonarQube Cloud check results as GitHub artifacts.

The code runs only on the default-branch workflow and never checks out or
executes source code from the event's commit. It outputs no credential values.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler

SONAR_PROJECT = 'staguak_aktualizator-nl-ue'  # Confirmed from SonarCloud GitHub check-run details
MAX_ISSUE_PAGES = 20
SAFE_REPO = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')


class ExportError(RuntimeError):
    pass


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ExportError('API_REDIRECT_BLOCKED')


def fetch_json(url: str, token: str | None = None) -> dict | list:
    # All outbound requests are confined to two hard-coded HTTPS API hosts.
    parts = urlparse(url)
    if (parts.scheme != 'https' or parts.netloc not in ('api.github.com', 'sonarcloud.io')
            or parts.username or parts.password or parts.fragment
            or '..' in parts.path.split('/')):
        raise ExportError('UNTRUSTED_API_HOST_OR_URL')
    if parts.netloc == 'api.github.com' and not parts.path.startswith('/repos/'):
        raise ExportError('UNTRUSTED_GITHUB_ROUTE')
    if parts.netloc == 'sonarcloud.io' and not parts.path.startswith('/api/'):
        raise ExportError('UNTRUSTED_SONAR_ROUTE')
    headers = {'Accept': 'application/vnd.github+json' if parts.netloc == 'api.github.com'
               else 'application/json', 'User-Agent': 'aktualizator-report-archive'}
    if token and parts.netloc == 'api.github.com':
        headers['Authorization'] = 'Bearer ' + token
    request = Request(url, headers=headers)
    try:
        # Never forward credentials through HTTP redirects to an unexpected host.
        with build_opener(RejectRedirects()).open(request, timeout=20) as response:
            return json.load(response)
    except HTTPError as exc:
        raise ExportError(f'HTTP_{exc.code}') from None
    except (URLError, TimeoutError, ValueError) as exc:
        raise ExportError(type(exc).__name__) from None


class GitHub:
    def __init__(self, repo: str, token: str, getter=fetch_json):
        if not SAFE_REPO.fullmatch(repo):
            raise ExportError('INVALID_REPOSITORY')
        self.repo, self.token, self.getter = repo, token, getter

    def get(self, suffix: str):
        if not suffix.startswith('/') or '://' in suffix or '\\' in suffix:
            raise ExportError('INVALID_API_ROUTE')
        return self.getter(f'https://api.github.com/repos/{self.repo}{suffix}', self.token)


def select(source: dict, keys: tuple[str, ...]) -> dict:
    return {key: source.get(key) for key in keys}


def collect_paginated(gh: GitHub, suffix: str, collection: str, max_pages: int = 10):
    result = []
    for page in range(1, max_pages + 1):
        response = gh.get(suffix + ('&' if '?' in suffix else '?') + f'per_page=100&page={page}')
        chunk = response.get(collection, []) if isinstance(response, dict) else response
        if not isinstance(chunk, list):
            raise ExportError('INVALID_PAGINATION_RESPONSE')
        result.extend(chunk)
        if len(chunk) < 100:
            return result, True
    return result, False


def sonar_check(gh: GitHub, check: dict) -> dict:
    check_id = int(check['id'])
    actual = gh.get(f'/check-runs/{check_id}')
    if actual.get('app', {}).get('slug') != 'sonarqubecloud':
        raise ExportError('CHECK_NOT_SONARQUBE_CLOUD')
    result = select(actual, ('id', 'name', 'head_sha', 'status', 'conclusion',
                              'started_at', 'completed_at', 'html_url', 'details_url'))
    result['app'] = actual['app']['slug']
    result['output'] = select(actual.get('output') or {},
                              ('title', 'summary', 'text', 'annotations_count'))
    if int(result['output'].get('annotations_count') or 0) > 0:
        try:
            ann, complete = collect_paginated(gh, f'/check-runs/{check_id}/annotations', 'annotations')
            result['annotations'] = ann
            result['annotationsComplete'] = complete and len(ann) >= int(result['output']['annotations_count'])
        except ExportError as exc:
            result['annotationsError'] = str(exc)
    return result


def sonar_selector(check: dict) -> tuple[str, dict]:
    """Bind optional Sonar API reads to the *same* branch or PR as the check."""
    url = urlparse(check.get('details_url') or '')
    if url.scheme != 'https' or url.hostname != 'sonarcloud.io' or url.path != '/dashboard':
        raise ExportError('SONAR_CHECK_HAS_NO_VERIFIED_ANALYSIS_URL')
    params = parse_qs(url.query)
    project = (params.get('id') or [''])[0]
    if not re.fullmatch(r'[A-Za-z0-9_.:-]+', project):
        raise ExportError('SONAR_PROJECT_UNVERIFIED')
    for key in ('pullRequest', 'branch'):
        if len(params.get(key, [])) == 1 and params[key][0]:
            return project, {key: params[key][0]}
    raise ExportError('SONAR_ANALYSIS_BRANCH_UNVERIFIED')


def sonar_api_snapshot(project: str = SONAR_PROJECT, selector: dict | None = None,
                       getter=fetch_json) -> dict:
    """Best-effort public Sonar API export for a verified branch/PR selector."""
    base = 'https://sonarcloud.io/api/'
    if not selector or set(selector) not in ({'pullRequest'}, {'branch'}):
        raise ExportError('SONAR_ANALYSIS_BRANCH_UNVERIFIED')
    snapshot = {'projectKey': project, 'selector': selector, 'endpoint': 'https://sonarcloud.io'}
    endpoints = {
        'qualityGate': 'qualitygates/project_status?' + urlencode({'projectKey': project} | selector),
        'measures': 'measures/component?' + urlencode({'component': project, 'metricKeys':
                    'bugs,vulnerabilities,code_smells,security_hotspots,coverage,duplicated_lines_density,'
                    'ncloc,reliability_rating,security_rating,sqale_rating'} | selector),
    }
    for name, route in endpoints.items():
        try:
            snapshot[name] = getter(base + route)
        except ExportError as exc:
            snapshot[name + 'Error'] = str(exc)
    issues = []
    total = None
    try:
        for page in range(1, MAX_ISSUE_PAGES + 1):
            params = urlencode({'componentKeys': project, 'ps': 500, 'p': page} | selector)
            response = getter(base + 'issues/search?' + params)
            chunk = response.get('issues', [])
            if not isinstance(chunk, list):
                raise ExportError('INVALID_ISSUES_RESPONSE')
            total = response.get('paging', {}).get('total', response.get('total'))
            issues.extend(chunk)
            if not chunk or (total is not None and len(issues) >= total):
                break
        snapshot['issues'] = issues
        snapshot['issuesReportedTotal'] = total
        snapshot['issuesComplete'] = total is not None and len(issues) >= total
    except ExportError as exc:
        snapshot['issues'] = issues
        snapshot['issuesReportedTotal'] = total
        snapshot['issuesComplete'] = False
        snapshot['issuesError'] = str(exc)
    return snapshot


def export_workflow_run(gh: GitHub, event: dict) -> dict:
    run = event['workflow_run']
    run_id = int(run['id'])
    actual = gh.get(f'/actions/runs/{run_id}')
    jobs, jobs_complete = collect_paginated(gh, f'/actions/runs/{run_id}/jobs', 'jobs')
    record = {
        'workflow': select(actual, ('id', 'name', 'event', 'run_attempt', 'head_branch',
                      'head_sha', 'status', 'conclusion', 'created_at', 'run_started_at',
                      'updated_at', 'html_url')),
        'jobs': [select(job, ('id', 'name', 'status', 'conclusion', 'started_at',
                 'completed_at', 'html_url', 'steps')) for job in jobs],
        'jobsComplete': jobs_complete,
    }
    sha = actual.get('head_sha')
    if sha and re.fullmatch(r'[a-fA-F0-9]{40}', sha):
        try:
            commit = gh.get(f'/commits/{sha}')
            record['git'] = {
                'sha': commit.get('sha'),
                'message': commit.get('commit', {}).get('message'),
                'authorName': commit.get('commit', {}).get('author', {}).get('name'),
                'authoredAt': commit.get('commit', {}).get('author', {}).get('date'),
                'htmlUrl': commit.get('html_url'),
                'stats': commit.get('stats'),
                'files': [select(f, ('filename', 'status', 'additions', 'deletions',
                           'changes', 'previous_filename')) for f in commit.get('files', [])],
            }
        except ExportError as exc:
            record['git'] = {'sha': sha, 'error': str(exc)}
        try:
            max_wait = max(0, min(180, int(os.environ.get('SONAR_WAIT_SECONDS', '0'))))
            deadline = time.monotonic() + max_wait
            while True:
                checks, complete = collect_paginated(gh, f'/commits/{sha}/check-runs', 'check_runs')
                sonar = [c for c in checks if c.get('app', {}).get('slug') == 'sonarqubecloud']
                if (sonar and all(c.get('status') == 'completed' for c in sonar)) or \
                   actual.get('name') != 'Verify public updater code' or \
                   actual.get('conclusion') == 'cancelled' or time.monotonic() >= deadline:
                    break
                time.sleep(min(10, max(0, deadline - time.monotonic())))
            record['sonarChecks'] = [select(c, ('id', 'name', 'status', 'conclusion',
                                     'details_url', 'started_at', 'completed_at'))
                                     for c in sonar]
            record['sonarChecksComplete'] = complete
            record['sonarReports'] = []
            for sonar_result in sonar:
                if sonar_result.get('status') != 'completed':
                    continue
                detailed = sonar_check(gh, sonar_result)
                entry = {'check': detailed}
                try:
                    project, selector = sonar_selector(detailed)
                    entry['sonarApi'] = sonar_api_snapshot(project=project, selector=selector)
                except ExportError as exc:
                    entry['sonarApi'] = {'status': 'unavailable', 'reason': str(exc)}
                record['sonarReports'].append(entry)
        except ExportError as exc:
            record['sonarChecksError'] = str(exc)
    return record


def export(event_name: str, event: dict, gh: GitHub, sonar_getter=fetch_json) -> dict:
    metadata = {'event': event_name, 'repository': gh.repo,
                'capturedAtUtc': datetime.now(timezone.utc).isoformat(),
                'source': 'GitHub API / SonarQube Cloud API'}
    if event.get('repository', {}).get('full_name') != gh.repo:
        raise ExportError('EVENT_REPOSITORY_MISMATCH')
    if event_name == 'workflow_run':
        metadata['type'] = 'git-actions'
        metadata['data'] = export_workflow_run(gh, event)
    elif event_name == 'check_run':
        if event['check_run'].get('app', {}).get('slug') != 'sonarqubecloud':
            raise ExportError('CHECK_NOT_SONARQUBE_CLOUD')
        metadata['type'] = 'sonarqube-cloud'
        metadata['check'] = sonar_check(gh, event['check_run'])
        try:
            project, selector = sonar_selector(metadata['check'])
            metadata['sonarApi'] = sonar_api_snapshot(project=project, selector=selector,
                                                       getter=sonar_getter)
        except ExportError as exc:
            metadata['sonarApi'] = {'status': 'unavailable', 'reason': str(exc)}
    else:
        raise ExportError('UNSUPPORTED_EVENT')
    return metadata


def main() -> int:
    path = Path(os.environ['GITHUB_EVENT_PATH'])
    output = Path('github-reports')  # fixed directory; never derived from the event or CLI
    output.mkdir(parents=True, exist_ok=True)
    try:
        with path.open(encoding='utf-8') as stream:
            event = json.load(stream)
        gh = GitHub(os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_TOKEN'])
        event_name = os.environ['GITHUB_EVENT_NAME']
        reconcile_id = os.environ.get('SONAR_RECONCILE_CHECK_ID')
        if reconcile_id is not None:
            if event_name not in ('schedule', 'workflow_dispatch', 'workflow_run'):
                raise ExportError('UNAUTHORIZED_RECONCILIATION_EVENT')
            if not re.fullmatch(r'[1-9][0-9]{0,18}', reconcile_id):
                raise ExportError('INVALID_RECONCILIATION_CHECK_ID')
            # The real check is fetched by its repository-scoped ID and its
            # SonarCloud GitHub App identity is verified before export.
            event = {'repository': {'full_name': gh.repo},
                     'check_run': {'id': int(reconcile_id),
                                   'app': {'slug': 'sonarqubecloud'}}}
            event_name = 'check_run'
        report = export(event_name, event, gh)
        if reconcile_id is not None:
            report['captureMode'] = 'scheduled-reconciliation'
        (output / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(f"Archived report type: {report['type']}")
        return 0
    except (ExportError, KeyError, ValueError) as exc:
        # Preserve a truthful failure marker; the upload step runs even after failure.
        (output / 'export-error.json').write_text(json.dumps({'status': 'failed',
                 'reason': str(exc), 'event': os.environ.get('GITHUB_EVENT_NAME')}, indent=2) + '\n', encoding='utf-8')
        print('Report export failed:', exc, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
