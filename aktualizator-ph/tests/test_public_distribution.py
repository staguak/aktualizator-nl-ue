"""Publication boundaries and secret-configuration materialization."""
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'aktualizator-ph'
spec = importlib.util.spec_from_file_location('private_config', APP / 'scripts/write_private_config.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class PublicDistributionTests(unittest.TestCase):
    def test_only_main_manual_workflow_can_access_drive_and_schedule_is_absent(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/updater.yml').read_text())
        events = workflow.get('on', workflow.get(True))
        self.assertEqual(set(events), {'workflow_dispatch'})
        job = workflow['jobs']['validate']
        self.assertEqual(job['environment'], 'updater')
        self.assertIn("github.ref == 'refs/heads/main'", job['if'])
        self.assertEqual(job['runs-on'], 'ubuntu-24.04')
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertFalse(workflow['concurrency']['cancel-in-progress'])
        steps = job['steps']
        for step in steps:
            self.assertNotIn('upload-artifact', step.get('uses', ''))
            if 'uses' in step:
                self.assertRegex(step['uses'], r'@[a-f0-9]{40}$')
        run = next(s for s in steps if s.get('name') == 'Run paired preflight, durable operation and final byte check')
        self.assertIn('> .release-production.log 2>&1', run['run'])
        self.assertNotIn('tee', run['run'])

    def test_pr_code_checks_have_no_drive_secret_or_privileged_event(self):
        text = (ROOT / '.github/workflows/verify-code.yml').read_text()
        workflow = yaml.safe_load(text)
        events = workflow.get('on', workflow.get(True))
        self.assertNotIn('pull_request_target', events)
        self.assertIn('pull_request', events)
        self.assertNotIn('secrets.', text)
        self.assertNotIn('environment:', text)

    def test_private_config_rejects_path_traversal_and_writes_private_files(self):
        values = {name: {'test': 'private'} for name in config.FILES}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'config'
            config.materialize(json.dumps(values), directory)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            for name in config.FILES:
                self.assertEqual(stat.S_IMODE((directory / name).stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                config.materialize(json.dumps(values), directory)
            values['../escape'] = {}
            with self.assertRaises(ValueError):
                config.materialize(json.dumps(values), Path(tmp) / 'other')
            self.assertFalse((Path(tmp) / 'escape').exists())

    def test_distribution_does_not_carry_private_installation_ownership(self):
        text = (APP / 'src/drive-release-store.ts').read_text()
        self.assertIn("const OWNER='nl-eu-public-updater-releases-v1'", text)
        self.assertNotIn("const OWNER='alwaysworks-releases-v1'", text)
        self.assertIn('const PRESERVED_ROOTS=new Set<string>();', text)
        approval = json.loads((APP / 'config/release-consumers.json').read_text())
        self.assertFalse(approval['approved'])
        self.assertTrue(all(c['verified'] is False for c in approval['consumers']))


if __name__ == '__main__':
    unittest.main()
