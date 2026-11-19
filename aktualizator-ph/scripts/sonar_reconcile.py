"""Discover SonarQube Cloud check runs missing a durable GitHub artifact.

This job runs on a trusted GitHub Actions revision. It only reads repository
metadata; it never executes code from commits discovered in PRs or branches.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys

from export_run_reports import ExportError, GitHub, SONAR_PROJECT, sonar_selector

LOOKBACK_DAYS = 89  # Do not re-archive expired events older than 90-day artifact TTL.
MAX_BATCH = 12
MAX_CHECK_PAGES = 3
MAX_ARTIFACT_PAGES = 40
MAX_PR_PAGES = 2
MAX_BRANCH_PAGES = 2
SHA = re.compile(r'^[a-fA-F0-9]{40}$')
ARTIFACT = re.compile(r'^sonar-check-([1-9][0-9]*)$')


def timestamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError('Timestamp must be a string')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp requires a timezone')
    return parsed.astimezone(timezone.utc)


def eligible_checks(items: list[dict], now: datetime | None = None) -> list[dict]:
    if now is None:
        now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=LOOKBACK_DAYS)
    accepted: list[dict] = []
    for item in items:
        try:
            if (item.get('app', {}).get('slug') != 'sonarqubecloud'
                    or item.get('status') != 'completed'):
                continue
            check_id = item.get('id')
            if type(check_id) is not int or check_id <= 0:
                continue
            if not SHA.fullmatch(item.get('head_sha') or ''):
                continue
            completed = timestamp(item.get('completed_at'))
            if not cutoff <= completed <= now + timedelta(minutes=5):
                continue
            project, selector = sonar_selector(item)
            if project != SONAR_PROJECT or not selector:
                continue
            accepted.append(item)
        except (ValueError, ExportError, TypeError, AttributeError):
            continue
    return accepted


def select_missing(items: list[dict], archived: set[str], limit: int = MAX_BATCH) -> list[dict]:
    if limit <= 0:
        raise ValueError('limit must be positive')
    unique: dict[int, dict] = {}
    for item in items:
        unique[int(item['id'])] = item
    newest = sorted(unique.values(), key=lambda row: (row.get('completed_at') or '', row['id']),
                    reverse=True)
    return [item for item in newest if f"sonar-check-{item['id']}" not in archived][:limit]


def collect_artifact_names(gh: GitHub) -> set[str]:
    names = set()
    for page in range(1, MAX_ARTIFACT_PAGES + 1):
        response = gh.get(f'/actions/artifacts?per_page=100&page={page}')
        rows = response.get('artifacts')
        if not isinstance(rows, list):
            raise ExportError('INVALID_ARTIFACT_LIST')
        for artifact in rows:
            name = artifact.get('name')
            if not artifact.get('expired', False) and isinstance(name, str) and ARTIFACT.fullmatch(name):
                names.add(name)
        if len(rows) < 100:
            return names
    raise ExportError('INCOMPLETE_ARTIFACT_HISTORY')


def collect_heads(gh: GitHub) -> set[str]:
    # Default branch and PR heads; sources may include fork commits, but they
    # are used only as *opaque IDs* for GitHub API reads.
    response = gh.get('/git/ref/heads/main')
    main = response.get('object', {}).get('sha')
    if not isinstance(main, str) or not SHA.fullmatch(main):
        raise ExportError('INVALID_MAIN_SHA')
    heads = {main}
    for page in range(1, MAX_PR_PAGES + 1):
        prs = gh.get('/pulls?state=all&sort=updated&direction=desc&per_page=100&page=' + str(page))
        if not isinstance(prs, list):
            raise ExportError('INVALID_PULL_REQUEST_LIST')
        for pr in prs:
            sha = (pr.get('head') or {}).get('sha')
            if isinstance(sha, str) and SHA.fullmatch(sha):
                heads.add(sha)
        if len(prs) < 100:
            break
    else:
        raise ExportError('INCOMPLETE_PR_HISTORY')
    for page in range(1, MAX_BRANCH_PAGES + 1):
        branches = gh.get('/branches?per_page=100&page=' + str(page))
        if not isinstance(branches, list):
            raise ExportError('INVALID_BRANCH_LIST')
        for branch in branches:
            sha = (branch.get('commit') or {}).get('sha')
            if isinstance(sha, str) and SHA.fullmatch(sha):
                heads.add(sha)
        if len(branches) < 100:
            break
    else:
        raise ExportError('INCOMPLETE_BRANCH_HISTORY')
    return heads


def collect_check_runs(gh: GitHub, sha: str) -> list[dict]:
    results = []
    total = None
    for page in range(1, MAX_CHECK_PAGES + 1):
        response = gh.get(f'/commits/{sha}/check-runs?filter=all&per_page=100&page={page}')
        chunk = response.get('check_runs')
        if not isinstance(chunk, list):
            raise ExportError('INVALID_CHECK_RUN_LIST')
        results.extend(chunk)
        total = response.get('total_count', len(results))
        if not isinstance(total, int) or total < len(results):
            raise ExportError('INVALID_CHECK_RUN_COUNT')
        if len(results) >= total:
            return results
        if len(chunk) < 100:
            raise ExportError('INCOMPLETE_CHECK_HISTORY')
    raise ExportError('INCOMPLETE_CHECK_HISTORY')


def discover(gh: GitHub, now: datetime | None = None) -> dict:
    if now is None:
        now = datetime.now(timezone.utc)
    existing = collect_artifact_names(gh)
    heads = collect_heads(gh)
    candidates = []
    for sha in sorted(heads):
        candidates.extend(eligible_checks(collect_check_runs(gh, sha), now=now))
    # One check ID is one independently archived analysis. A fresh Sonar
    # check with the same commit SHA is NOT deduplicated by SHA.
    missing = select_missing(candidates, existing, limit=MAX_BATCH)
    return {
        'checks': [{'id': item['id']} for item in missing],
        'headsChecked': len(heads),
        'candidateChecks': len({item['id'] for item in candidates}),
        'selected': len(missing),
    }


def emit_output(path: Path, checks: list[dict]) -> None:
    payload = json.dumps(checks, separators=(',', ':'), ensure_ascii=True)
    with path.open('a', encoding='utf-8') as stream:
        stream.write('checks=' + payload + '\n')


def main() -> int:
    try:
        gh = GitHub(os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_TOKEN'])
        result = discover(gh)
        if 'GITHUB_OUTPUT' not in os.environ:
            raise ExportError('MISSING_GITHUB_OUTPUT')
        emit_output(Path(os.environ['GITHUB_OUTPUT']), result['checks'])
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        if 'GITHUB_STEP_SUMMARY' in os.environ:
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
                summary.write(
                    f"Sonar reconciliation: checked {result['headsChecked']} commit heads; "
                    f"selected {result['selected']} missing report(s).\n")
        return 0
    except (ExportError, KeyError, ValueError, OSError) as exc:
        print('Sonar reconciliation discovery FAILED:', str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
