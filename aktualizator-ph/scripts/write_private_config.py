"""Materialize optional secret configuration without logging its contents."""
import json
import os
from pathlib import Path
import sys

FILES = {'aktualizator.json', 'zakres.json', 'zakres-ue.json', 'release-consumers.json'}


def materialize(raw, directory):
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != FILES:
        raise ValueError('Expected exactly four configuration objects')
    if any(not isinstance(v, dict) for v in value.values()):
        raise ValueError('Configuration files must be JSON objects')
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, data in value.items():
        with (directory / name).open('x', encoding='utf-8') as f:
            os.chmod(f.name, 0o600)
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write('\n')


def main():
    raw = os.environ.get('LAW_CONFIG_JSON', '')
    if not raw:
        print('Using the repository example configuration.')
        return
    directory = Path(os.environ['RUNNER_TEMP']) / 'nl-eu-updater-config'
    materialize(raw, directory)
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as f:
        f.write('LAW_CONFIG_DIR=' + str(directory) + '\n')
    print('Private configuration loaded.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Private configuration could not be loaded; contents were not logged.', file=sys.stderr)
        sys.exit(1)
